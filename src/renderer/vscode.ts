import { repoSlug } from '../repo.js';
import { hasRepo, isJvmImage, type Stack } from '../schema.js';

// Mismo placeholder que usa el renderer de compose en los binds del repo.
const REPOS_DIR_VAR = '${REPOS_DIR}';

// Genera el contenido de .vscode/launch.json para attach al debugger de cada
// service con debug_port + launch del browser para services con
// vscode.browser. Incluye una compound config para attach a todos a la vez.
//
// El attach siempre apunta al puerto HOST (`debug_port`), que es el publicado;
// `debug_port_container` solo existe del lado de adentro del container.
export function renderVscodeLaunch(stack: Stack): string {
  const configurations: Array<Record<string, unknown>> = [];
  const compounds: Array<Record<string, unknown>> = [];
  const attachNames: string[] = [];

  for (const [name, svc] of Object.entries(stack.services)) {
    if (svc.debug_port !== undefined) {
      const cfgName = `[${stack.name}] Attach (${name})`;
      attachNames.push(cfgName);
      configurations.push(attachConfig(stack, name, svc.debug_port, cfgName));
    }

    if (svc.vscode?.browser !== undefined) {
      configurations.push(browserConfig(stack, name, svc));
    }
  }

  // Tasks que corren en el host con `vscode:`: launch que primero las arranca
  // en modo debug (preLaunchTask) y después se attachea. No van en el
  // "Attach all": lanzan un proceso, no se enganchan a uno que ya corre.
  for (const [name, task] of Object.entries(stack.tasks ?? {})) {
    if (!task.vscode) continue;
    const v = task.vscode;
    const cfg: Record<string, unknown> = {
      name: `[${stack.name}] ${v.label ?? name}`,
      type: v.type,
      request: 'attach',
      preLaunchTask: taskDebugLabel(stack, name),
    };
    if (v.type === 'java') {
      cfg.hostName = 'localhost';
      cfg.port = v.debug_port;
      if (v.project) cfg.projectName = v.project;
    } else {
      cfg.address = 'localhost';
      cfg.port = v.debug_port;
      cfg.skipFiles = ['<node_internals>/**'];
    }
    configurations.push(cfg);
  }

  if (attachNames.length > 1) {
    compounds.push({
      name: `[${stack.name}] Attach all`,
      configurations: attachNames,
      stopAll: true,
    });
  }

  const launch: Record<string, unknown> = {
    version: '0.2.0',
    configurations,
  };
  if (compounds.length > 0) launch.compounds = compounds;

  return JSON.stringify(launch, null, 2) + '\n';
}

function attachConfig(
  stack: Stack,
  svcName: string,
  debugPort: number,
  name: string,
): Record<string, unknown> {
  const svc = stack.services[svcName]!;

  // Mismo criterio que usa el renderer de compose para no inyectar NODE_OPTIONS.
  const type = svc.vscode?.type ?? (isJvmImage(svc.image) ? 'java' : 'node');

  const cfg: Record<string, unknown> = {
    name,
    type,
    request: 'attach',
  };

  if (type === 'java') {
    cfg.hostName = 'localhost';
    cfg.port = debugPort;
    if (svc.vscode?.project) cfg.projectName = svc.vscode.project;
  } else if (type === 'python') {
    cfg.connect = {
      host: 'localhost',
      port: debugPort,
    };
    cfg.justMyCode = true;
  } else {
    cfg.address = 'localhost';
    cfg.port = debugPort;
    cfg.restart = true;
    cfg.timeout = 30000;
    cfg.skipFiles = ['<node_internals>/**'];
  }

  // Si el service monta el código del host adentro del container, mapear paths
  // para que VS Code resuelva los source files al filesystem local.
  if (hasRepo(svc) && svc.working_dir) {
    const slug = repoSlug(svc.repo);
    const localRoot = `\${workspaceFolder}/repos/${slug}`;
    // El remoteRoot correcto es donde está montado el REPO, que no siempre es
    // el working_dir: en un monorepo el bind va a /app y el working_dir baja a
    // /app/<package>. Si se usara el working_dir, VS Code resolvería cada
    // archivo un nivel adentro y no matchearía ningún breakpoint.
    const remoteRoot = repoMountTarget(svc, slug) ?? svc.working_dir;
    if (type === 'python') {
      cfg.pathMappings = [{ localRoot, remoteRoot }];
    } else if (type !== 'java') {
      cfg.localRoot = localRoot;
      cfg.remoteRoot = remoteRoot;
    }
  }

  return cfg;
}

// Busca el bind mount del repo (`REPOS_DIR/<slug>:<target>`) y devuelve su
// target adentro del container. undefined si el service no lo declara.
function repoMountTarget(svc: Stack['services'][string], slug: string): string | undefined {
  for (const spec of svc.volumes ?? []) {
    const parts = spec.split(':');
    if (parts.length < 2) continue;
    if (parts[0] === `${REPOS_DIR_VAR}/${slug}`) return parts[1];
  }
  return undefined;
}

function browserConfig(
  stack: Stack,
  svcName: string,
  svc: Stack['services'][string],
): Record<string, unknown> {
  const browser = svc.vscode!.browser!;
  const label = browser.label ?? `Browser (${svcName})`;
  const url = browserUrl(stack, svc);

  const cfg: Record<string, unknown> = {
    name: `[${stack.name}] ${label}`,
    // `chrome` (js-debug): `pwa-chrome` era el nombre de cuando js-debug era opcional y VS Code ya
    // lo marca como viejo.
    type: 'chrome',
    request: 'launch',
    url,
    sourceMaps: true,
  };
  if (browser.up) cfg.preLaunchTask = upLabel(stack, svcName);
  if (browser.window) {
    const [ancho, alto] = browser.window.split('x');
    cfg.runtimeArgs = [`--window-size=${ancho},${alto}`];
  }

  if (hasRepo(svc)) {
    const slug = repoSlug(svc.repo);
    let subPath = '';
    if (svc.working_dir) {
      const prefix = `/workspace/${slug}`;
      if (svc.working_dir.startsWith(prefix)) {
        subPath = svc.working_dir.slice(prefix.length);
      }
    }
    cfg.webRoot = `\${workspaceFolder}/repos/${slug}${subPath}`;
    cfg.sourceMapPathOverrides = {
      'webpack:///*': '${webRoot}/*',
    };
  }

  return cfg;
}

// Línea que imprime cada runtime cuando su debugger ya acepta conexiones.
const READY_POR_TIPO: Record<string, string> = {
  java: 'Listening for transport dt_socket',
  node: 'Debugger listening on',
};

export function taskLabel(stack: Stack, taskName: string): string {
  return `[${stack.name}] ${taskName}`;
}

export function taskDebugLabel(stack: Stack, taskName: string): string {
  return `[${stack.name}] ${taskName} (debug)`;
}

export function upLabel(stack: Stack, svcName: string): string {
  return `[${stack.name}] om up ${svcName}`;
}

// Genera .vscode/tasks.json para las tasks del stack que declaran `vscode:`:
// una que las corre tal cual y otra con `debug_args`, de fondo, que VS Code da
// por lista cuando aparece la línea `ready` (la usa el preLaunchTask). Corren
// con cwd en la raíz del stack, igual que `om <task>`. Devuelve null si
// ninguna task declara `vscode:`.
export function renderVscodeTasks(stack: Stack): string | null {
  const tasks: Array<Record<string, unknown>> = [];
  for (const [name, task] of Object.entries(stack.tasks ?? {})) {
    if (!task.vscode) continue;
    const v = task.vscode;
    const base = {
      type: 'shell',
      options: { cwd: '${workspaceFolder}' },
      presentation: { reveal: 'always', panel: 'dedicated' },
    };
    tasks.push({ label: taskLabel(stack, name), detail: task.description, command: task.run, ...base, problemMatcher: [] });
    tasks.push({
      label: taskDebugLabel(stack, name),
      detail: `${task.description} (con debug en localhost:${v.debug_port})`,
      command: v.debug_args ? `${task.run} ${v.debug_args}` : task.run,
      ...base,
      isBackground: true,
      problemMatcher: {
        owner: `om-${name}`,
        pattern: { regexp: '^\\b$' },
        background: { activeBegins: true, beginsPattern: '.', endsPattern: v.ready ?? READY_POR_TIPO[v.type] },
      },
    });
  }
  // Launchers de navegador con `up: true`: levantar el service y esperar a
  // que la url conteste (hasta 2 minutos) antes de abrir el navegador.
  for (const [name, svc] of Object.entries(stack.services)) {
    const b = svc.vscode?.browser;
    if (!b?.up) continue;
    const url = browserUrl(stack, svc);
    tasks.push({
      label: upLabel(stack, name),
      detail: `om up ${name} y espera a ${url}`,
      type: 'shell',
      command: `om up ${name} && i=0; until curl -sf -o /dev/null '${url}'; do i=$((i+1)); [ $i -ge 120 ] && echo 'no responde ${url}' && exit 1; sleep 1; done`,
      options: { cwd: '${workspaceFolder}' },
      presentation: { reveal: 'silent', panel: 'shared' },
      problemMatcher: [],
    });
  }
  if (tasks.length === 0) return null;
  return JSON.stringify({ version: '2.0.0', tasks }, null, 2) + '\n';
}

function browserUrl(stack: Stack, svc: Stack['services'][string]): string {
  return (
    svc.vscode?.browser?.url ??
    (stack.gateway ? `http://localhost:${stack.gateway.port}/` : `http://localhost:${svc.port}/`)
  );
}
