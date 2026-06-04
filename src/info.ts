import { relative } from 'node:path';
import type { LoadedStack } from './parser.js';
import { hasRepo, type Service, type Stack } from './schema.js';

const PLACEHOLDER_PATTERNS = [
  /^changeit-/i,
  /^dev-default-/i,
  /^replace-me/i,
  /^tbd$/i,
  /^insert-/i,
  /^your-/i,
];

const WRAP_WIDTH = 78;
const DESC_INDENT = '       ';   // 7 espacios — alineado con texto post-marker

const C = supportsColor()
  ? {
      reset: '\x1b[0m',
      dim: '\x1b[2m',
      bold: '\x1b[1m',
      cyan: '\x1b[36m',
      yellow: '\x1b[33m',
      green: '\x1b[32m',
      red: '\x1b[31m',
      magenta: '\x1b[35m',
    }
  : { reset: '', dim: '', bold: '', cyan: '', yellow: '', green: '', red: '', magenta: '' };

function supportsColor(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
}

export function renderInfo(loaded: LoadedStack): string {
  const out: string[] = [];
  const { stack } = loaded;
  const sourceLabel = relative(process.cwd(), loaded.sourcePath) || loaded.sourcePath;

  const services = Object.entries(stack.services);
  const gw = stack.gateway;

  out.push(
    `${C.bold}${stack.name}${C.reset}  ${C.dim}${services.length} services${
      gw ? ` · gateway en :${gw.port}` : ''
    } · ${sourceLabel}${C.reset}`,
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
      out.push(`  ${' '.repeat(maxName + 2)}${C.dim}${r.url}${C.reset}`);
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
    const maxUrl = Math.max(...sorted.map((r) => urlFor(gw.port, r.path).length));
    for (const route of sorted) {
      const url = urlFor(gw.port, route.path);
      const note = route.strip_prefix ? `  ${C.dim}(strip prefix)${C.reset}` : '';
      out.push(`  ${url.padEnd(maxUrl + 2)}→ ${route.service}${note}`);
    }
  }

  const debugConfigs = services.filter(([, s]) => s.debug_port !== undefined);
  if (debugConfigs.length > 0) {
    out.push('');
    out.push(section('Debug') + `  ${C.dim}(om vscode genera launch.json)${C.reset}`);
    const maxName = Math.max(...debugConfigs.map(([n]) => n.length));
    for (const [name, svc] of debugConfigs) {
      out.push(
        `  ${name.padEnd(maxName + 2)}${C.dim}attach →${C.reset} localhost:${svc.debug_port}`,
      );
    }
  }

  const concerns = collectConcerns(loaded);
  if (concerns.length > 0) {
    out.push('');
    out.push(`${C.yellow}⚠${C.reset}  ${C.bold}Probablemente quieras tocar${C.reset}`);
    const grouped = groupByService(concerns);
    for (const [svcName, items] of grouped) {
      out.push('');
      out.push(`  ${C.cyan}${svcName}${C.reset}`);
      for (const c of items) {
        out.push(`    ${renderConcernLine(c)}`);
        if (c.location) {
          out.push(`    ${DESC_INDENT}${C.dim}${c.location}${C.reset}`);
        }
        if (c.description) {
          for (const line of wrapText(c.description, WRAP_WIDTH - DESC_INDENT.length)) {
            out.push(`    ${DESC_INDENT}${C.dim}${line}${C.reset}`);
          }
        }
      }
    }

    out.push('');
    const requiredCount = concerns.filter((c) => c.required).length;
    const optionalCount = concerns.length - requiredCount;
    out.push(
      `  ${C.dim}Total:${C.reset} ${
        requiredCount > 0 ? `${C.red}${requiredCount} required${C.reset}` : `${C.green}0 required${C.reset}`
      }${C.dim} · ${optionalCount} opcionales${C.reset}`,
    );
  } else {
    out.push('');
    out.push(`${C.green}✓${C.reset} no detecté placeholders ni valores vacíos`);
  }

  return out.join('\n') + '\n';
}

function renderConcernLine(c: Concern): string {
  const marker = c.required
    ? `${C.red}✗${C.reset}`
    : c.reason.startsWith('placeholder')
    ? `${C.yellow}!${C.reset}`
    : `${C.dim}·${C.reset}`;
  const tag = c.required ? ` ${C.red}[required]${C.reset}` : '';
  return `${marker}${tag} ${C.bold}${c.key}${C.reset} ${C.dim}— ${c.reason}${C.reset}`;
}

function groupByService(concerns: Concern[]): Map<string, Concern[]> {
  const grouped = new Map<string, Concern[]>();
  for (const c of concerns) {
    const list = grouped.get(c.service) ?? [];
    list.push(c);
    grouped.set(c.service, list);
  }
  // Ordenar items de cada service: required arriba.
  for (const list of grouped.values()) {
    list.sort((a, b) => (b.required ? 1 : 0) - (a.required ? 1 : 0));
  }
  return grouped;
}

function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current);
  return lines;
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
  return repo.replace(/\.git$/, '').split(/[/:]/).pop() ?? repo;
}

function urlFor(port: number, path: string): string {
  const cleaned = path.replace(/^=\s*/, '');
  return `http://localhost:${port}${cleaned === '/' ? '/' : cleaned}`;
}

function effectiveLen(path: string): number {
  return path.replace(/^(=|\^~)\s*/, '').length;
}

type RepoEntry = { slug: string; ref: string | undefined; url: string };

function collectRepos(stack: Stack): RepoEntry[] {
  const seen = new Map<string, RepoEntry>();
  for (const svc of Object.values(stack.services)) {
    if (!hasRepo(svc)) continue;
    const slug = svc.repo.replace(/\.git$/, '').split(/[/:]/).pop()!;
    if (!seen.has(slug)) seen.set(slug, { slug, ref: svc.ref, url: svc.repo });
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

type Concern = {
  service: string;
  key: string;
  reason: string;
  description?: string;
  required?: boolean;
  location?: string;       // "arch/stack.yaml:42" — clickeable en VS Code terminal
};

function collectConcerns(loaded: LoadedStack): Concern[] {
  const out: Concern[] = [];
  const sourceRel = relative(process.cwd(), loaded.sourcePath) || loaded.sourcePath;

  for (const [svcName, svc] of Object.entries(loaded.stack.services)) {
    const meta = svc.env_meta ?? {};
    for (const [k, vRaw] of Object.entries(svc.env ?? {})) {
      const v = String(vRaw);
      const m = meta[k] ?? {};

      let reason: string | null = null;
      if (v === '') reason = 'vacío';
      else if (PLACEHOLDER_PATTERNS.some((re) => re.test(v))) {
        reason = `placeholder "${truncate(v, 30)}"`;
      }

      if (reason !== null) {
        const concern: Concern = { service: svcName, key: k, reason };
        if (m.description) concern.description = m.description;
        if (m.required) concern.required = m.required;
        const loc = loaded.locations.get(`${svcName}.${k}`);
        if (loc) concern.location = `${sourceRel}:${loc.line}:${loc.col}`;
        out.push(concern);
      }
    }
  }

  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
