import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStack } from './init.js';
import { renderInfo } from './info.js';
import { loadStack, type LoadedStack } from './parser.js';
import { renderCompose } from './renderer/compose.js';
import { renderDbInit } from './renderer/db-init.js';
import { renderEnv } from './renderer/env.js';
import { renderNginx } from './renderer/nginx.js';
import { renderScripts } from './renderer/scripts.js';
import { renderVscodeLaunch } from './renderer/vscode.js';
import { syncStack, type SyncResult } from './sync.js';

const COMMANDS = [
  'init',
  'sync',
  'gen',
  'validate',
  'info',
  'vscode',
  'up',
  'down',
  'stop',
  'restart',
  'build',
  'logs',
  'ps',
  'help',
  'version',
] as const;
type Command = (typeof COMMANDS)[number];

// Versión del propio engine — leída del package.json del paquete instalado.
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = readVersion();

function printUsage(): void {
  console.log(`om v${VERSION} — orquestador declarativo mínimo

setup:
  om init                              crea un stack.yaml template en la carpeta actual
  om sync                              clone/pull de los repos declarados (services.*.repo)
  om gen [stack.yaml] [--out <dir>]    rinde compose + nginx + scripts en .stack/
  om validate [stack.yaml]             solo valida el stack
  om info                              resumen del stack + qué probablemente quieras tocar
  om vscode                            genera .vscode/launch.json (attach + browser)

runtime:
  om up [args...]                      docker compose up -d
  om down [args...]                    docker compose down (remueve containers)
  om stop [args...]                    docker compose stop (sin remove)
  om restart [service]                 docker compose restart
  om build [service]                   docker compose build
  om logs [service]                    docker compose logs -f --tail=200
  om ps                                docker compose ps

  om help                              muestra esta ayuda
  om version | --version | -v          muestra la versión del CLI (${VERSION})

Sin path explícito, busca el stack.yaml más cercano subiendo desde la carpeta actual.
`);
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return 0;
  }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printUsage();
    return 0;
  }

  if (!COMMANDS.includes(cmd as Command)) {
    console.error(`comando desconocido: ${cmd}\n`);
    printUsage();
    return 1;
  }

  try {
    switch (cmd as Command) {
      case 'init':
        return runInit();
      case 'sync':
        return runSync();
      case 'validate':
        return runValidate(rest);
      case 'gen':
        return runGen(rest);
      case 'info':
        return runInfo();
      case 'vscode':
        return runVscode();
      case 'up':
        return runDockerCompose(['up', '-d', ...rest]);
      case 'down':
        return runDockerCompose(['down', ...rest]);
      case 'stop':
        return runDockerCompose(['stop', ...rest]);
      case 'restart':
        return runDockerCompose(['restart', ...rest]);
      case 'build':
        return runDockerCompose(['build', ...rest]);
      case 'logs':
        return runDockerCompose(['logs', '-f', '--tail=200', ...rest]);
      case 'ps':
        return runDockerCompose(['ps', ...rest]);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  return 1;
}

function parseStackArg(args: string[]): { stackPath: string | undefined; rest: string[] } {
  if (args[0] && !args[0].startsWith('-')) {
    return { stackPath: args[0], rest: args.slice(1) };
  }
  return { stackPath: undefined, rest: args };
}

function runInit(): number {
  const result = initStack(process.cwd());
  if (result.created) {
    console.log(`✓ ${result.message}`);
    return 0;
  }
  console.error(result.message);
  return 1;
}

function runSync(): number {
  const loaded = loadStack(undefined);
  const reposDir = resolve(loaded.workspaceRoot, 'repos');
  mkdirSync(reposDir, { recursive: true });

  console.log(
    `sync de ${Object.keys(loaded.stack.services).length} services en ${
      relative(process.cwd(), reposDir) || '.'
    }`,
  );

  const results = syncStack(loaded.stack, { workDir: loaded.workspaceRoot, reposDir });

  let failed = 0;
  for (const r of results) {
    const icon = iconFor(r);
    const detail = r.message ? ` — ${r.message}` : '';
    console.log(`  ${icon} ${r.service.padEnd(20)} ${r.action}${detail}`);
    if (r.action === 'failed' || r.action === 'local-missing') failed++;
  }

  return failed > 0 ? 1 : 0;
}

function iconFor(r: SyncResult): string {
  switch (r.action) {
    case 'cloned':
    case 'pulled':
    case 'switched':
    case 'local-ok':
      return '✓';
    case 'skipped-no-repo':
    case 'skipped-dup':
      return '·';
    case 'failed':
    case 'local-missing':
      return '✗';
  }
}

function runValidate(args: string[]): number {
  const { stackPath } = parseStackArg(args);
  const { stack } = loadStack(stackPath);
  console.log(`✓ ${stack.name} — ${Object.keys(stack.services).length} services`);
  return 0;
}

function runInfo(): number {
  const loaded = loadStack(undefined);
  process.stdout.write(renderInfo(loaded));
  return 0;
}

function runVscode(): number {
  const loaded = loadStack(undefined);
  const vscodeDir = resolve(loaded.workspaceRoot, '.vscode');
  mkdirSync(vscodeDir, { recursive: true });
  const target = join(vscodeDir, 'launch.json');
  const content = renderVscodeLaunch(loaded.stack);
  writeFileSync(target, content);

  const debugCount = Object.values(loaded.stack.services).filter((s) => s.debug_port).length;
  const browserCount = Object.values(loaded.stack.services).filter((s) => s.vscode?.browser).length;

  console.log(`✓ generado ${relative(process.cwd(), target)}`);
  console.log(`  ${debugCount} attach configs · ${browserCount} browser launchers`);
  return 0;
}

function runGen(args: string[]): number {
  const { stackPath, rest } = parseStackArg(args);
  const outIdx = rest.indexOf('--out');
  const explicitOut = outIdx >= 0 ? rest[outIdx + 1] : undefined;

  const loaded = loadStack(stackPath);
  const outDir = resolve(explicitOut ?? loaded.outDir);
  const reposDir = resolve(loaded.workspaceRoot, 'repos');

  mkdirSync(outDir, { recursive: true });

  const files: Array<{ path: string; content: string; mode?: number }> = [
    { path: 'docker-compose.yaml', content: renderCompose(loaded.stack) },
    { path: '.env', content: renderEnv(loaded.stack, { reposDir, stackDir: loaded.workDir }) },
  ];

  if (loaded.stack.gateway) {
    files.push({ path: 'nginx.conf', content: renderNginx(loaded.stack) });
  }

  for (const dbInit of renderDbInit(loaded.stack)) {
    files.push({ path: dbInit.path, content: dbInit.content });
  }

  for (const script of renderScripts(loaded.stack)) {
    files.push({
      path: script.path,
      content: script.content,
      ...(script.executable ? { mode: 0o755 } : {}),
    });
  }

  for (const file of files) {
    const fullPath = join(outDir, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content);
    if (file.mode !== undefined) chmodSync(fullPath, file.mode);
  }

  console.log(`✓ render completo en ${relative(process.cwd(), outDir) || '.'}`);
  console.log(
    `  ${files.length} archivos · ${Object.keys(loaded.stack.services).length} services${
      loaded.stack.gateway ? ' · gateway' : ''
    }`,
  );
  return 0;
}

function runDockerCompose(dockerArgs: string[]): number {
  const loaded = loadStack(undefined);
  ensureGenerated(loaded);

  const composePath = join(loaded.outDir, 'docker-compose.yaml');
  const envPath = join(loaded.outDir, '.env');

  const res = spawnSync(
    'docker',
    ['compose', '--env-file', envPath, '-f', composePath, ...dockerArgs],
    { stdio: 'inherit' },
  );

  if (res.error) {
    console.error(`error ejecutando docker compose: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

function ensureGenerated(loaded: LoadedStack): void {
  const composePath = join(loaded.outDir, 'docker-compose.yaml');
  if (!existsSync(composePath)) {
    throw new Error(
      `no se encuentra ${relative(process.cwd(), composePath)}\n` +
        `correr 'om gen' primero`,
    );
  }
}

process.exit(main(process.argv.slice(2)));
