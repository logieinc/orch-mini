import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LoadedStack } from './parser.js';
import { hasRepo, type Service, type Stack } from './schema.js';

// Patrones que sugieren "el usuario debería completar esto antes de prod".
const PLACEHOLDER_PATTERNS = [
  /^changeit-/i,
  /^dev-default-/i,
  /^replace-me/i,
  /^tbd$/i,
  /^insert-/i,
  /^your-/i,
];

const C = supportsColor()
  ? {
      reset: '\x1b[0m',
      dim: '\x1b[2m',
      bold: '\x1b[1m',
      cyan: '\x1b[36m',
      yellow: '\x1b[33m',
      green: '\x1b[32m',
      red: '\x1b[31m',
    }
  : { reset: '', dim: '', bold: '', cyan: '', yellow: '', green: '', red: '' };

function supportsColor(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
}

export function renderInfo(loaded: LoadedStack): string {
  const out: string[] = [];
  const { stack } = loaded;

  const services = Object.entries(stack.services);
  const gw = stack.gateway;

  out.push(
    header(`${stack.name}`) +
      `  ${C.dim}${services.length} services${gw ? ` · gateway en :${gw.port}` : ''}${C.reset}`,
  );

  out.push('');
  out.push(section('Services'));
  for (const [name, svc] of services) {
    out.push(`  ${formatServiceRow(name, svc)}`);
  }

  const repos = collectRepos(stack);
  if (repos.length > 0) {
    out.push('');
    out.push(section('Repos (om sync)'));
    const maxName = Math.max(...repos.map((r) => r.slug.length));
    for (const r of repos) {
      const refLabel = r.ref ?? `${C.dim}(default branch)${C.reset}`;
      out.push(`  ${r.slug.padEnd(maxName + 2)}${refLabel}`);
    }
  }

  const dbs = collectDatabases(stack);
  if (dbs.length > 0) {
    out.push('');
    out.push(section('Databases'));
    for (const db of dbs) {
      out.push(`  ${db.service}: ${db.names.join(', ')}`);
    }
  }

  if (gw) {
    out.push('');
    out.push(section('Endpoints (gateway)'));
    const sorted = [...gw.routes].sort(
      (a, b) => effectiveLen(b.path) - effectiveLen(a.path),
    );
    const maxUrl = Math.max(
      ...sorted.map((r) => urlFor(gw.port, r.path).length),
    );
    for (const route of sorted) {
      const url = urlFor(gw.port, route.path);
      const note = route.strip_prefix ? `  ${C.dim}(strip prefix)${C.reset}` : '';
      out.push(`  ${url.padEnd(maxUrl + 2)}→ ${route.service}${note}`);
    }
  }

  const debugConfigs = services.filter(([, s]) => s.debug_port !== undefined);
  if (debugConfigs.length > 0) {
    out.push('');
    out.push(section('Debug (VS Code attach via om vscode)'));
    for (const [name, svc] of debugConfigs) {
      out.push(`  ${name.padEnd(30)} attach → localhost:${svc.debug_port}`);
    }
  }

  const concerns = collectConcerns(stack, loaded.workDir);
  if (concerns.length > 0) {
    out.push('');
    out.push(`${C.yellow}⚠${C.reset}  ${C.bold}Probablemente quieras tocar${C.reset}`);
    const maxKey = Math.max(...concerns.map((c) => `${c.service}.${c.key}`.length));
    for (const c of concerns) {
      const k = `${c.service}.${c.key}`.padEnd(maxKey + 2);
      out.push(`  ${k}${C.dim}${c.reason}${C.reset}`);
    }
  } else {
    out.push('');
    out.push(`${C.green}✓${C.reset} no detecté placeholders ni valores vacíos`);
  }

  return out.join('\n') + '\n';
}

function header(text: string): string {
  return `${C.bold}${text}${C.reset}`;
}

function section(text: string): string {
  return `${C.cyan}${text}${C.reset}`;
}

function formatServiceRow(name: string, svc: Service): string {
  const image = svc.image ?? (hasRepo(svc) ? `build (${svc.build})` : '?');
  const repoLabel = hasRepo(svc) ? ` ${C.dim}(${shortenRepo(svc.repo)})${C.reset}` : '';
  const ports: string[] = [];
  if (svc.expose_host !== undefined) ports.push(`host:${svc.expose_host}`);
  if (svc.debug_port !== undefined) ports.push(`debug:${svc.debug_port}`);
  const portLabel = ports.length > 0 ? `  ${ports.join('  ')}` : '';
  const kind = svc.kind === 'oneshot' ? `  ${C.dim}[oneshot]${C.reset}` : '';
  return `${name.padEnd(30)} ${image}${repoLabel}${kind}${portLabel}`;
}

function shortenRepo(repo: string): string {
  // github.com/logieinc/foo.git → foo, /local → local
  return repo
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .pop() ?? repo;
}

function urlFor(port: number, path: string): string {
  const cleaned = path.replace(/^=\s*/, '');
  return `http://localhost:${port}${cleaned === '/' ? '/' : cleaned}`;
}

function effectiveLen(path: string): number {
  return path.replace(/^(=|\^~)\s*/, '').length;
}

type RepoEntry = { slug: string; ref: string | undefined };

function collectRepos(stack: Stack): RepoEntry[] {
  const seen = new Map<string, RepoEntry>();
  for (const svc of Object.values(stack.services)) {
    if (!hasRepo(svc)) continue;
    const slug = svc.repo
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .pop()!;
    if (!seen.has(slug)) seen.set(slug, { slug, ref: svc.ref });
  }
  return [...seen.values()];
}

function collectDatabases(stack: Stack): Array<{ service: string; names: string[] }> {
  const out: Array<{ service: string; names: string[] }> = [];
  for (const [name, svc] of Object.entries(stack.services)) {
    if (svc.databases && svc.databases.length > 0) {
      out.push({ service: name, names: [...svc.databases] });
    }
  }
  return out;
}

type Concern = { service: string; key: string; reason: string };

function collectConcerns(stack: Stack, workDir: string): Concern[] {
  const out: Concern[] = [];

  for (const [svcName, svc] of Object.entries(stack.services)) {
    for (const [k, vRaw] of Object.entries(svc.env ?? {})) {
      const v = String(vRaw);

      if (v === '') {
        out.push({ service: svcName, key: k, reason: 'vacío' });
        continue;
      }

      if (PLACEHOLDER_PATTERNS.some((re) => re.test(v))) {
        out.push({ service: svcName, key: k, reason: `placeholder: "${truncate(v, 30)}"` });
        continue;
      }

      // ${file:...} ya fue expandido en el parse — si llegamos acá y no
      // existe, el parse hubiera tirado error. No re-chequear acá.
    }
  }

  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
