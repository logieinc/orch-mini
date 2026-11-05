import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { STACK_FILENAME, STACK_SUBDIRS } from './discover.js';
import type { Require } from './schema.js';

// Dependencias entre stacks (`requires:`). Un stack declara qué otro stack
// tiene que estar arriba antes que él; `om up` lo verifica y explica qué falta.

// Dónde vive el stack.yaml del stack requerido. Por defecto es una carpeta
// hermana del workspace (los stacks de un catálogo viven uno al lado del otro).
export function requiredStackPath(workspaceRoot: string, req: Pick<Require, 'stack' | 'path'>): string {
  const dir = req.path ? resolve(workspaceRoot, req.path) : resolve(workspaceRoot, '..', req.stack);
  const candidates = [resolve(dir, STACK_FILENAME), ...STACK_SUBDIRS.map((s) => resolve(dir, s, STACK_FILENAME))];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `requires: no encuentro el stack '${req.stack}' (busqué ${candidates
      .map((c) => relative(process.cwd(), c))
      .join(' y ')}). Si vive en otra carpeta, indicala con 'path:'.`,
  );
}

// Nombre del proyecto de compose del stack requerido (name + -<mode> si declara
// modes), leído sin cargar el stack entero: alcanza con name/modes/default_mode.
// Es lo que hace falta para armar el nombre de su red antes de validar este.
export function requiredProjectName(stackPath: string, mode?: string): { project: string; mode?: string } {
  const doc = parseDocument(readFileSync(stackPath, 'utf8')).toJSON() as Record<string, unknown> | null;
  const name = doc?.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`requires: el stack en ${stackPath} no tiene 'name:'`);
  }
  const modes = Array.isArray(doc?.modes) ? doc.modes.map(String) : [];
  if (modes.length === 0) return { project: name };
  const active = mode ?? (typeof doc?.default_mode === 'string' ? doc.default_mode : undefined);
  if (!active || !modes.includes(active)) {
    throw new Error(
      `requires: el stack '${name}' declara modes: [${modes.join(', ')}]; indicá cuál con 'mode:'`,
    );
  }
  return { project: `${name}-${active}`, mode: active };
}

export type ServiceState = { service: string; problem: string };

// Services del proyecto que no están listos: no existen, no corren, o tienen
// healthcheck y todavía no dan healthy. Vacío = todo bien.
export function servicesNotReady(project: string, wanted: string[]): ServiceState[] {
  const res = spawnSync(
    'docker',
    [
      'ps',
      '-a',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--format',
      '{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Status}}',
    ],
    { encoding: 'utf8' },
  );
  if (res.error || res.status !== 0) {
    return wanted.map((service) => ({ service, problem: 'no pude consultar docker (¿está corriendo?)' }));
  }
  const seen = new Map<string, { state: string; status: string }>();
  for (const line of res.stdout.split('\n')) {
    const [service, state, status] = line.split('\t');
    if (service) seen.set(service, { state: state ?? '', status: status ?? '' });
  }
  const out: ServiceState[] = [];
  for (const service of wanted) {
    const s = seen.get(service);
    if (!s) out.push({ service, problem: 'no está creado' });
    else if (s.state !== 'running') out.push({ service, problem: `está ${s.state}` });
    else if (s.status.includes('(unhealthy)')) out.push({ service, problem: 'corre pero está unhealthy' });
    else if (s.status.includes('(health: starting)')) out.push({ service, problem: 'todavía está arrancando' });
  }
  return out;
}

// Corre el `check` de un ready en el workspace del stack requerido.
export function readyCheckPasses(check: string, cwd: string): boolean {
  const res = spawnSync('sh', ['-c', check], { cwd, stdio: 'ignore' });
  return !res.error && res.status === 0;
}

// Stacks que tienen containers conectados a la red de este proyecto: quiénes se
// quedan sin servicio si se lo baja.
export function consumersOf(project: string): Map<string, number> {
  const consumers = new Map<string, number>();
  const net = spawnSync(
    'docker',
    ['network', 'inspect', `${project}_default`, '--format', '{{range .Containers}}{{.Name}} {{end}}'],
    { encoding: 'utf8' },
  );
  if (net.error || net.status !== 0) return consumers;
  const containers = net.stdout.split(/\s+/).filter((n) => n.length > 0);
  if (containers.length === 0) return consumers;
  const labels = spawnSync(
    'docker',
    ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', ...containers],
    { encoding: 'utf8' },
  );
  if (labels.error || labels.status !== 0) return consumers;
  for (const p of labels.stdout.split('\n')) {
    if (!p || p === project) continue;
    consumers.set(p, (consumers.get(p) ?? 0) + 1);
  }
  return consumers;
}

// Workspace del stack requerido (donde se corren sus om up/tasks): el padre
// de arch/ si el yaml vive ahí.
export function requiredWorkspace(stackPath: string): string {
  const dir = dirname(stackPath);
  return (STACK_SUBDIRS as readonly string[]).some((s) => dir.endsWith(`/${s}`)) ? dirname(dir) : dir;
}
