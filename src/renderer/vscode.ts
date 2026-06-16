import { repoSlug } from '../repo.js';
import { hasRepo, type Stack } from '../schema.js';

// Genera el contenido de .vscode/launch.json para attach al inspector Node
// de cada service con debug_port + launch del browser para services con
// vscode.browser. Incluye una compound config para attach a todos a la vez.
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
  
  // Detect debugger type
  let type = svc.vscode?.type;
  if (!type) {
    const img = svc.image || '';
    if (img.includes('maven') || img.includes('openjdk') || img.includes('eclipse-temurin') || img.includes('java')) {
      type = 'java';
    } else {
      type = 'node';
    }
  }

  const cfg: Record<string, unknown> = {
    name,
    type,
    request: 'attach',
  };

  if (type === 'java') {
    cfg.hostName = 'localhost';
    cfg.port = debugPort;
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
    if (type === 'python') {
      cfg.pathMappings = [
        {
          localRoot: `\${workspaceFolder}/repos/${repoSlug(svc.repo)}`,
          remoteRoot: svc.working_dir,
        }
      ];
    } else if (type !== 'java') {
      cfg.localRoot = `\${workspaceFolder}/repos/${repoSlug(svc.repo)}`;
      cfg.remoteRoot = svc.working_dir;
    }
  }

  return cfg;
}

function browserConfig(
  stack: Stack,
  svcName: string,
  svc: Stack['services'][string],
): Record<string, unknown> {
  const browser = svc.vscode!.browser!;
  const label = browser.label ?? `Browser (${svcName})`;
  const url =
    browser.url ??
    (stack.gateway ? `http://localhost:${stack.gateway.port}/` : `http://localhost:${svc.port}/`);

  const cfg: Record<string, unknown> = {
    name: `[${stack.name}] ${label}`,
    type: 'pwa-chrome',
    request: 'launch',
    url,
    sourceMaps: true,
  };

  if (hasRepo(svc)) {
    cfg.webRoot = `\${workspaceFolder}/repos/${repoSlug(svc.repo)}`;
  }

  return cfg;
}
