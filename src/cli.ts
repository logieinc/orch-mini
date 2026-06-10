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

function printUsage(mode?: string): void {
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

flag global (en cualquier subcomando):
  --mode=<name>                        elige el mode si el stack declara modes:
                                       (p.ej. --mode=local, --mode=cloud)
`);

  // Si hay un stack.yaml resoluble desde el cwd y declara tasks:, listarlas
  // como `tasks (de <stack-name>):`. No-op si no hay stack o no hay tasks.
  try {
    const loaded = loadStack(undefined, mode);
    const tasks = loaded.stack.tasks;
    if (tasks && Object.keys(tasks).length > 0) {
      console.log(`tasks (de ${loaded.stack.name}):`);
      const maxName = Math.max(...Object.keys(tasks).map((n) => n.length));
      for (const [name, t] of Object.entries(tasks)) {
        console.log(`  om ${name.padEnd(maxName + 2)} ${t.description}`);
      }
      console.log('');
    }
  } catch {
    // sin stack en el cwd — el listado de tasks es opcional, seguimos.
  }
}

// Extrae --mode=<x> o --mode <x> de cualquier posición de los args. Devuelve
// el resto sin esos tokens. Flag global — aplica a todos los subcomandos.
function extractModeArg(argv: string[]): { mode: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let mode: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--mode' && i + 1 < argv.length) {
      mode = argv[i + 1];
      i++;
      continue;
    }
    if (a.startsWith('--mode=')) {
      mode = a.slice('--mode='.length);
      continue;
    }
    rest.push(a);
  }
  return { mode, rest };
}

function main(argv: string[]): number {
  const { mode, rest: argvNoMode } = extractModeArg(argv);
  const [cmd, ...rest] = argvNoMode;

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return 0;
  }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printUsage(mode);
    return 0;
  }

  if (!COMMANDS.includes(cmd as Command)) {
    // Antes de fallar, ver si el cmd resuelve a una task declarada en el
    // stack.yaml más cercano. Esto habilita `om <task-name> [args...]`.
    return runTaskOrFail(cmd, rest, mode);
  }

  try {
    switch (cmd as Command) {
      case 'init':
        return runInit();
      case 'sync':
        return runSync(mode);
      case 'validate':
        return runValidate(rest, mode);
      case 'gen':
        return runGen(rest, mode);
      case 'info':
        return runInfo(mode);
      case 'vscode':
        return runVscode(mode);
      case 'up':
        return runDockerCompose(['up', '-d', ...rest], mode);
      case 'down':
        return runDockerCompose(['down', ...rest], mode);
      case 'stop':
        return runDockerCompose(['stop', ...rest], mode);
      case 'restart':
        return runDockerCompose(['restart', ...rest], mode);
      case 'build':
        return runDockerCompose(['build', ...rest], mode);
      case 'logs':
        return runDockerCompose(['logs', '-f', '--tail=200', ...rest], mode);
      case 'ps':
        return runDockerCompose(['ps', ...rest], mode);
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

function runSync(mode?: string): number {
  const loaded = loadStack(undefined, mode);
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

function runValidate(args: string[], mode?: string): number {
  const { stackPath } = parseStackArg(args);
  const { stack, activeMode } = loadStack(stackPath, mode);
  const modeLabel = activeMode ? ` (mode: ${activeMode})` : '';
  console.log(`✓ ${stack.name} — ${Object.keys(stack.services).length} services${modeLabel}`);
  return 0;
}

function runInfo(mode?: string): number {
  const loaded = loadStack(undefined, mode);
  process.stdout.write(renderInfo(loaded));
  return 0;
}

function runVscode(mode?: string): number {
  const loaded = loadStack(undefined, mode);
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

function runGen(args: string[], mode?: string): number {
  const { stackPath, rest } = parseStackArg(args);
  const outIdx = rest.indexOf('--out');
  const explicitOut = outIdx >= 0 ? rest[outIdx + 1] : undefined;

  const loaded = loadStack(stackPath, mode);
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

function runDockerCompose(dockerArgs: string[], mode?: string): number {
  const loaded = loadStack(undefined, mode);
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

function runTaskOrFail(cmd: string, args: string[], mode?: string): number {
  // Cargar el stack — si falla (no hay yaml o no parsea), tratar como
  // comando desconocido y mostrar usage. Si carga pero el cmd no es una
  // task declarada, listar las tasks disponibles.
  let loaded: LoadedStack;
  try {
    loaded = loadStack(undefined, mode);
  } catch {
    console.error(`comando desconocido: ${cmd}\n`);
    printUsage(mode);
    return 1;
  }

  const task = loaded.stack.tasks?.[cmd];
  if (!task) {
    const available = Object.keys(loaded.stack.tasks ?? {});
    console.error(`comando desconocido: ${cmd}`);
    if (available.length > 0) {
      console.error(`tasks declaradas en el stack: ${available.join(', ')}`);
    } else {
      console.error(`(el stack '${loaded.stack.name}' no declara tasks:)`);
    }
    return 1;
  }

  // Ejecutar `task.run` como un comando de shell con los args adicionales
  // posicionalizados ("$@"). cwd = workspaceRoot para que `bash arch/x.sh`
  // resuelva como espera el dev (el yaml suele vivir en arch/).
  const shellCmd = `${task.run} "$@"`;
  const res = spawnSync('sh', ['-c', shellCmd, 'om-task', ...args], {
    stdio: 'inherit',
    cwd: loaded.workspaceRoot,
  });

  if (res.error) {
    console.error(`error ejecutando task '${cmd}': ${res.error.message}`);
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
