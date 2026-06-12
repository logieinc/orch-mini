import { spawnSync } from 'node:child_process';
import readline from 'node:readline';
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
import { runMenu, selectOption } from './menu.js';
import { runDoctor } from './doctor.js';
import { renderMermaid } from './renderer/graph.js';

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
  'recreate',
  'build',
  'logs',
  'ps',
  'menu',
  'doctor',
  'shell',
  'exec',
  'prune',
  'graph',
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

// ANSI styling — respeta NO_COLOR (https://no-color.org/) y solo colorea si
// stdout es TTY. Cuando se pipea o redirige a archivo, todo se ve plano.
const COLOR_ENABLED = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = (code: string, text: string): string =>
  COLOR_ENABLED ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = (t: string) => c('1', t);
const dim = (t: string) => c('2', t);
const cyan = (t: string) => c('36', t);
const yellow = (t: string) => c('33', t);
const magenta = (t: string) => c('35', t);
const green = (t: string) => c('32', t);

// Pinta una línea de comando: el `om <cmd>` se resalta en cyan/bold, los
// `[args]` opcionales en dim, y la descripción queda en color normal.
function cmdLine(cmd: string, desc: string): string {
  const cmdPad = 38;
  // Resaltar el verbo (primera palabra después de "om") en cyan.
  const m = cmd.match(/^(om )(\S+)( .*)?$/);
  let styled: string;
  if (m) {
    const om = m[1] ?? '';
    const verb = m[2] ?? '';
    const rest = m[3] ?? '';
    const restStyled = rest.replace(/\[[^\]]+\]/g, (x) => dim(x));
    styled = dim(om) + cyan(verb) + restStyled;
  } else {
    styled = cmd;
  }
  // Padding: cuento el ancho visible (sin códigos ANSI) para alinear bien.
  const visibleLen = cmd.length;
  const padding = ' '.repeat(Math.max(2, cmdPad - visibleLen));
  return `  ${styled}${padding}${desc}`;
}

function printUsage(mode?: string): void {
  const title = `${bold(magenta('om'))} ${dim('v' + VERSION)} ${dim('—')} ${bold('orquestador declarativo mínimo')}`;
  const rule = dim('─'.repeat(60));

  console.log(`
${title}
${rule}

${bold(yellow('setup'))}
${cmdLine('om init',                          'crea un stack.yaml template en la carpeta actual')}
${cmdLine('om sync',                          'clone/pull de los repos declarados (services.*.repo)')}
${cmdLine('om gen [stack.yaml] [--out <dir>]','rinde compose + nginx + scripts en .stack/')}
${cmdLine('om validate [stack.yaml]',         'solo valida el stack')}
${cmdLine('om info',                          'resumen del stack + qué probablemente quieras tocar')}
${cmdLine('om vscode',                        'genera .vscode/launch.json (attach + browser)')}
${cmdLine('om menu',                          'abre el menú interactivo de consola')}
${cmdLine('om doctor',                        'verifica el estado de docker, puertos y repositorios')}
${cmdLine('om graph [stack.yaml]',            'genera un diagrama Mermaid de la arquitectura')}

${bold(green('runtime'))}
${cmdLine('om up [service...]',               'docker compose up -d ' + dim('(regenera artefactos antes)'))}
${cmdLine('om down [service...]',             'sin args baja todo; con services hace ' + dim('rm -fs'))}
${cmdLine('om stop [service...]',             'docker compose stop ' + dim('(sin remove)'))}
${cmdLine('om restart [service...]',          'docker compose restart ' + dim('(soft, no recrea)'))}
${cmdLine('om recreate [service...]',         'up -d --force-recreate ' + dim('(aplica cambios de env)'))}
${cmdLine('om build [service...]',            'docker compose build')}
${cmdLine('om logs [service...]',             'docker compose logs -f --tail=200')}
${cmdLine('om ps',                            'docker compose ps')}
${cmdLine('om shell [service]',               'entra a la consola (sh) de un servicio')}
${cmdLine('om exec <service> <cmd> [args...]', 'ejecuta un comando en un contenedor')}
${cmdLine('om prune [--force]',               'detiene y remueve contenedores, redes y volúmenes')}

${bold(dim('meta'))}
${cmdLine('om help',                          'muestra esta ayuda')}
${cmdLine('om version | --version | -v',      'muestra la versión del CLI ' + dim('(' + VERSION + ')'))}

${dim('Sin path explícito, busca el stack.yaml más cercano subiendo desde la carpeta actual.')}

${bold(yellow('flag global'))} ${dim('(en cualquier subcomando)')}
  ${cyan('--mode=<name>')}${' '.repeat(24)}elige el mode si el stack declara ${bold('modes:')}
  ${' '.repeat(37)}${dim('p.ej.')} --mode=local, --mode=cloud
  ${' '.repeat(37)}${dim('stacks con modes renderizan en .stack/<mode>/')}
  ${' '.repeat(37)}${dim('para que cloud y local puedan convivir')}
`);

  // Si hay un stack.yaml resoluble desde el cwd y declara tasks:, listarlas
  // como `tasks (de <stack-name>):`. No-op si no hay stack o no hay tasks.
  try {
    const loaded = loadStack(undefined, mode);
    const tasks = loaded.stack.tasks;
    if (tasks && Object.keys(tasks).length > 0) {
      console.log(`${bold(magenta('tasks'))} ${dim('(de ' + loaded.stack.name + ')')}`);
      const maxName = Math.max(...Object.keys(tasks).map((n) => n.length));
      for (const [name, t] of Object.entries(tasks)) {
        console.log(cmdLine(`om ${name}`, t.description).padEnd(maxName + 2));
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

async function main(argv: string[]): Promise<number> {
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
      case 'menu':
        return await runMenu({ runDockerCompose, runSync, runValidate, runGen, runVscode, runDoctor }, mode);
      case 'doctor': {
        const { stackPath } = parseStackArg(rest);
        return await runDoctor(stackPath, mode);
      }
      case 'up':
        return runDockerCompose(['up', '-d', ...rest], mode);
      case 'down':
        // `docker compose down` no acepta servicios — baja todo el stack.
        // Si el caller pasó services, traducir a `rm -fs <services>` que sí
        // los baja individualmente (stop + remove sin tocar volumes/networks).
        return rest.length > 0
          ? runDockerCompose(['rm', '-fs', ...rest], mode)
          : runDockerCompose(['down'], mode);
      case 'stop':
        return runDockerCompose(['stop', ...rest], mode);
      case 'restart':
        return runDockerCompose(['restart', ...rest], mode);
      case 'recreate':
        return runDockerCompose(['up', '-d', '--force-recreate', ...rest], mode);
      case 'build':
        return runDockerCompose(['build', ...rest], mode);
      case 'logs':
        return runDockerCompose(['logs', '-f', '--tail=200', ...rest], mode);
      case 'ps':
        return runDockerCompose(['ps', ...rest], mode);
      case 'shell':
        return await runShell(rest, mode);
      case 'exec':
        return runExec(rest, mode);
      case 'prune':
        return await runPrune(rest, mode);
      case 'graph':
        return runGraph(rest, mode);
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

export function runSync(mode?: string): number {
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

export function runValidate(args: string[], mode?: string): number {
  const { stackPath } = parseStackArg(args);
  const { stack, activeMode, overridePath } = loadStack(stackPath, mode);
  const modeLabel = activeMode ? ` (mode: ${activeMode})` : '';
  const overrideLabel = overridePath ? ' (con override local)' : '';
  console.log(`✓ ${stack.name} — ${Object.keys(stack.services).length} services${modeLabel}${overrideLabel}`);
  return 0;
}

function runInfo(mode?: string): number {
  const loaded = loadStack(undefined, mode);
  process.stdout.write(renderInfo(loaded));
  return 0;
}

export function runVscode(mode?: string): number {
  const loaded = loadStack(undefined, mode);
  generateVscode(loaded);
  return 0;
}

// Extraído de runVscode para que `up` lo pueda invocar sin re-cargar el stack.
function generateVscode(loaded: LoadedStack): void {
  const vscodeDir = resolve(loaded.workspaceRoot, '.vscode');
  mkdirSync(vscodeDir, { recursive: true });
  const target = join(vscodeDir, 'launch.json');
  const content = renderVscodeLaunch(loaded.stack);
  writeFileSync(target, content);

  const debugCount = Object.values(loaded.stack.services).filter((s) => s.debug_port).length;
  const browserCount = Object.values(loaded.stack.services).filter((s) => s.vscode?.browser).length;

  console.log(`✓ generado ${relative(process.cwd(), target)}`);
  console.log(`  ${debugCount} attach configs · ${browserCount} browser launchers`);
}

export function runGen(args: string[], mode?: string): number {
  const { stackPath, rest } = parseStackArg(args);
  const outIdx = rest.indexOf('--out');
  const explicitOut = outIdx >= 0 ? rest[outIdx + 1] : undefined;

  const loaded = loadStack(stackPath, mode);
  const outDir = resolve(explicitOut ?? loaded.outDir);
  generateArtifacts(loaded, outDir);
  return 0;
}

// Extraído de runGen para que `up` lo pueda invocar sin re-cargar el stack.
function generateArtifacts(loaded: LoadedStack, outDir: string): void {
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
}

export function runDockerCompose(dockerArgs: string[], mode?: string): number {
  const loaded = loadStack(undefined, mode);

  // `up` (incluido `up --force-recreate` de `om recreate`) auto-regenera
  // compose + vscode launch.json antes de levantar. Garantiza que el compose
  // levantado refleja el stack.yaml actual y que el debug de VS Code matchea
  // los puertos del mode activo. Los demás subcomandos (down/rm/stop/restart/
  // build/logs/ps) usan lo que esté ya generado.
  if (dockerArgs[0] === 'up') {
    generateArtifacts(loaded, loaded.outDir);
    generateVscode(loaded);
  } else {
    ensureGenerated(loaded);
  }

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
    const modeHint = loaded.activeMode ? ` --mode=${loaded.activeMode}` : '';
    throw new Error(
      `no se encuentra ${relative(process.cwd(), composePath)}\n` +
        `correr 'om gen${modeHint}' primero`,
    );
  }
}

async function runShell(args: string[], mode?: string): Promise<number> {
  const loaded = loadStack(undefined, mode);
  const serviceNames = Object.keys(loaded.stack.services);

  let svc = args[0];
  if (!svc) {
    if (serviceNames.length === 0) {
      console.error('El stack no tiene servicios definidos.');
      return 1;
    }
    if (serviceNames.length === 1) {
      svc = serviceNames[0]!;
    } else {
      const choice = await selectOption('Selecciona un servicio para entrar a su shell:', [
        ...serviceNames,
        '[Cancelar]'
      ]);
      if (choice === serviceNames.length) {
        return 0; // cancelado
      }
      svc = serviceNames[choice]!;
      console.clear();
    }
  }

  if (!loaded.stack.services[svc]) {
    console.error(`Error: el servicio "${svc}" no existe en el stack.`);
    return 1;
  }

  return runDockerCompose(['exec', svc, 'sh'], mode);
}

function runExec(args: string[], mode?: string): number {
  if (args.length < 2) {
    console.error('Uso: om exec <service> <comando> [args...]');
    return 1;
  }
  const [svc, ...cmdArgs] = args;
  const loaded = loadStack(undefined, mode);
  if (!loaded.stack.services[svc!]) {
    console.error(`Error: el servicio "${svc}" no existe en el stack.`);
    return 1;
  }
  return runDockerCompose(['exec', svc!, ...cmdArgs], mode);
}

async function runPrune(args: string[], mode?: string): Promise<number> {
  const force = args.includes('--force') || args.includes('-y') || args.includes('-f');

  if (!force) {
    console.log('\x1b[33m⚠️  ¡ADVERTENCIA! Esta acción detendrá el stack y ELIMINARÁ todos los volúmenes de base de datos y datos locales.\x1b[0m');
    const confirmed = await askConfirmation('¿Estás seguro de que deseas continuar?');
    if (!confirmed) {
      console.log('Operación cancelada.');
      return 0;
    }
  }

  console.log('Limpiando recursos del stack...');
  return runDockerCompose(['down', '-v', '--remove-orphans'], mode);
}

function askConfirmation(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`  ${question} (s/N): `, (answer) => {
      rl.close();
      const val = answer.toLowerCase().trim();
      resolve(val === 's' || val === 'y' || val === 'si');
    });
  });
}

function runGraph(args: string[], mode?: string): number {
  const { stackPath } = parseStackArg(args);
  const loaded = loadStack(stackPath, mode);
  const mermaidStr = renderMermaid(loaded.stack);
  process.stdout.write(mermaidStr);
  return 0;
}

main(process.argv.slice(2)).then(code => process.exit(code)).catch(err => {
  console.error(err);
  process.exit(1);
});
