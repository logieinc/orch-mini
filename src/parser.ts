import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { isMap, isPair, isScalar, LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { expandFileRefs } from './file-refs.js';
import { findStack, STACK_FILENAME, STACK_SUBDIRS } from './discover.js';
import { stackSchema, type Stack } from './schema.js';

// Mapa de "service.envKey" → {line, col} del archivo fuente.
// Habilita reportes con archivo:línea clickeables en VS Code terminal.
export type Locations = Map<string, { line: number; col: number }>;

export type LoadedStack = {
  stack: Stack;
  sourcePath: string;
  overridePath?: string;    // path al override local cargado (si existe)
  workDir: string;          // dirname(stack.yaml)
  workspaceRoot: string;    // donde van repos/ y .stack/ — padre del workDir si el yaml vive en arch/
  outDir: string;           // workspaceRoot/.stack
  locations: Locations;
  activeMode: string | null;  // mode activo (null si el stack no declara modes)
  declaredModes?: string[];   // modes declarados en stack.yaml (si existen)
};

export function loadStack(stackPath?: string, requestedMode?: string): LoadedStack {
  let absPath: string;
  if (stackPath) {
    absPath = resolve(process.cwd(), stackPath);
  } else {
    const found = findStack();
    if (!found) {
      throw new Error(
        `no se encontró ${STACK_FILENAME} en ${process.cwd()} ni en ninguna carpeta superior`,
      );
    }
    absPath = found;
  }

  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`no se pudo leer el stack en ${absPath}: ${msg}`);
  }

  const lineCounter = new LineCounter();
  let docNode: ReturnType<typeof parseDocument>;
  try {
    docNode = parseDocument(raw, { lineCounter });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`YAML inválido en ${absPath}: ${msg}`);
  }

  const workDir = resolve(absPath, '..');
  const locations = collectLocations(docNode, lineCounter);

  // Plain JS desde el AST para los pasos siguientes.
  let docPlain = docNode.toJSON();

  // Buscar stack.override.yaml o stack.override.yml en la misma carpeta
  const parsedPath = parse(absPath);
  const overrideYamlPath = join(parsedPath.dir, 'stack.override.yaml');
  const overrideYmlPath = join(parsedPath.dir, 'stack.override.yml');
  let overridePath: string | undefined;
  if (existsSync(overrideYamlPath)) {
    overridePath = overrideYamlPath;
  } else if (existsSync(overrideYmlPath)) {
    overridePath = overrideYmlPath;
  }

  if (overridePath) {
    try {
      const overrideRaw = readFileSync(overridePath, 'utf8');
      const overrideDoc = parseDocument(overrideRaw);
      const overridePlain = overrideDoc.toJSON() || {};
      docPlain = deepMerge(docPlain, overridePlain);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`YAML de override inválido en ${overridePath}: ${msg}`);
    }
  }

  // Resolver modes ANTES de cualquier otra transformación. Filtra services
  // por `modes:`, resuelve `{by_mode: {...}}` al mode activo, sufija el name
  // del stack con el mode, y borra los campos modes/default_mode del root.
  const { resolved, activeMode, declaredModes } = applyModes(docPlain, requestedMode, absPath);

  // Expandir ${file:path} antes de validar — paths se resuelven relativo al workDir.
  const expanded = expandFileRefs(resolved, workDir);

  // Normalizar el formato mixed de env (string | {value, description, required})
  // a dos campos planos: env (Record<string,string>) + env_meta (descripciones).
  const normalized = normalizeEnvMetadata(expanded);

  const result = stackSchema.safeParse(normalized);
  if (!result.success) {
    throw new Error(formatZodError(result.error, absPath));
  }

  // Mergear common_env en cada service.env. Marca env_meta.from_common=true
  // en cada var heredada para que info pueda deduplicar.
  const stack = mergeCommonEnv(result.data);

  const workspaceRoot = computeWorkspaceRoot(workDir);

  // outDir mode-aware: si el stack declara modes, cada mode tiene su propia
  // carpeta render `.stack/<mode>/`. Permite tener cloud y local levantados
  // a la vez sin que el render se pise. Stacks sin modes mantienen `.stack/`
  // plano (compat backward).
  const outDir = activeMode
    ? resolve(workspaceRoot, '.stack', activeMode)
    : resolve(workspaceRoot, '.stack');

  return {
    stack,
    sourcePath: absPath,
    overridePath,
    workDir,
    workspaceRoot,
    outDir,
    locations,
    activeMode,
    declaredModes,
  };
}

function mergeCommonEnv(stack: Stack): Stack {
  if (!stack.common_env || Object.keys(stack.common_env).length === 0) return stack;
  const commonEnv = stack.common_env;
  const commonMeta = stack.common_env_meta ?? {};

  const newServices: typeof stack.services = {};
  for (const [name, svc] of Object.entries(stack.services)) {
    const mergedEnv: Record<string, string> = { ...commonEnv, ...(svc.env ?? {}) };

    const mergedMeta: typeof svc.env_meta = {};
    // Para cada var del common, agregar su meta marcada from_common=true.
    for (const [k, v] of Object.entries(commonEnv)) {
      // si el service no la overridea, viene del común
      if (svc.env?.[k] === undefined) {
        mergedMeta[k] = { ...(commonMeta[k] ?? {}), from_common: true };
      }
    }
    // Luego, las metas del service tienen prioridad.
    for (const [k, m] of Object.entries(svc.env_meta ?? {})) {
      mergedMeta[k] = m;
    }

    newServices[name] = {
      ...svc,
      env: mergedEnv,
      env_meta: Object.keys(mergedMeta).length > 0 ? mergedMeta : svc.env_meta,
    };
  }
  return { ...stack, services: newServices };
}

// Recorre el AST del YAML y extrae line/col de cada services.<svc>.env.<KEY>
// y de cada common_env.<KEY>. Keys de common_env quedan como "(common).<KEY>".
function collectLocations(
  doc: ReturnType<typeof parseDocument>,
  lineCounter: LineCounter,
): Locations {
  const locations: Locations = new Map();

  // common_env del root
  const commonEnv = doc.get('common_env', true);
  if (isMap(commonEnv)) {
    for (const envPair of commonEnv.items) {
      if (!isPair(envPair) || !isScalar(envPair.key)) continue;
      const key = String(envPair.key.value);
      const range = envPair.key.range;
      if (!range) continue;
      const pos = lineCounter.linePos(range[0]);
      locations.set(`(common).${key}`, { line: pos.line, col: pos.col });
    }
  }

  // services.<svc>.env.<KEY>
  const services = doc.get('services', true);
  if (!isMap(services)) return locations;

  for (const svcPair of services.items) {
    if (!isPair(svcPair) || !isScalar(svcPair.key)) continue;
    const svcName = String(svcPair.key.value);

    const svcNode = svcPair.value;
    if (!isMap(svcNode)) continue;

    const envNode = svcNode.get('env', true);
    if (!isMap(envNode)) continue;

    for (const envPair of envNode.items) {
      if (!isPair(envPair) || !isScalar(envPair.key)) continue;
      const key = String(envPair.key.value);
      const range = envPair.key.range;
      if (!range) continue;
      const pos = lineCounter.linePos(range[0]);
      locations.set(`${svcName}.${key}`, { line: pos.line, col: pos.col });
    }
  }

  return locations;
}

function computeWorkspaceRoot(workDir: string): string {
  // Si el stack.yaml vive en un subdir convencional (arch/), el workspaceRoot
  // es el padre — repos/ y .stack/ no se mezclan con la definición.
  if ((STACK_SUBDIRS as readonly string[]).includes(basename(workDir))) {
    return dirname(workDir);
  }
  return workDir;
}

// Splittea env values en formato mixed (string | {value,description,required})
// a dos campos planos: env (Record<string,string>) + env_meta (descripciones).
// Aplica a stack.services.*.env y también a stack.common_env.
function normalizeEnvMetadata(doc: unknown): unknown {
  if (!isPlainObject(doc)) return doc;
  const out: Record<string, unknown> = { ...doc };

  // common_env del root
  if (isPlainObject(out.common_env)) {
    const { values, meta } = splitMixedEnv(out.common_env);
    out.common_env = values;
    if (Object.keys(meta).length > 0) out.common_env_meta = meta;
  }

  // services.*.env
  if (isPlainObject(out.services)) {
    const newServices: Record<string, unknown> = {};
    for (const [svcName, svc] of Object.entries(out.services)) {
      if (!isPlainObject(svc) || !isPlainObject(svc.env)) {
        newServices[svcName] = svc;
        continue;
      }
      const { values, meta } = splitMixedEnv(svc.env);
      const newSvc: Record<string, unknown> = { ...svc, env: values };
      if (Object.keys(meta).length > 0) newSvc.env_meta = meta;
      newServices[svcName] = newSvc;
    }
    out.services = newServices;
  }

  return out;
}

function splitMixedEnv(envMap: Record<string, unknown>): {
  values: Record<string, unknown>;
  meta: Record<string, { description?: string; required?: boolean }>;
} {
  const values: Record<string, unknown> = {};
  const meta: Record<string, { description?: string; required?: boolean }> = {};
  for (const [k, v] of Object.entries(envMap)) {
    if (isPlainObject(v) && ('value' in v || 'description' in v || 'required' in v)) {
      values[k] = v.value ?? '';
      const m: { description?: string; required?: boolean } = {};
      if (typeof v.description === 'string') m.description = v.description;
      if (typeof v.required === 'boolean') m.required = v.required;
      if (Object.keys(m).length > 0) meta[k] = m;
    } else {
      values[k] = v;
    }
  }
  return { values, meta };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Aplica modes al doc raw antes de la validación zod. Si el stack declara
// `modes:`, determina el mode activo (param > default_mode > error), filtra
// services cuyo `service.modes:` no incluye el activo, resuelve cualquier
// `{by_mode: {...}}` al valor del mode, sufija `name` con `-<mode>`, y borra
// los campos `modes`/`default_mode` del root. Si el stack NO declara modes,
// no transforma nada (compat con stacks single-mode).
function applyModes(
  doc: unknown,
  requestedMode: string | undefined,
  sourcePath: string,
): { resolved: unknown; activeMode: string | null; declaredModes?: string[] } {
  if (!isPlainObject(doc)) return { resolved: doc, activeMode: null };

  const declaredModes = doc.modes;
  const defaultMode = doc.default_mode;

  // Sin modes declarados: tolerar --mode pasado (warning sería bueno pero por
  // ahora silent) y pasar por el doc tal cual. requestedMode se ignora.
  if (!Array.isArray(declaredModes) || declaredModes.length === 0) {
    if (requestedMode !== undefined) {
      throw new Error(
        `--mode=${requestedMode} pasado pero el stack en ${sourcePath} no declara 'modes:'`,
      );
    }
    return { resolved: doc, activeMode: null };
  }

  // Determinar mode activo: param > default_mode > error.
  let activeMode: string;
  if (requestedMode !== undefined) {
    activeMode = requestedMode;
  } else if (typeof defaultMode === 'string' && defaultMode.length > 0) {
    activeMode = defaultMode;
  } else {
    throw new Error(
      `stack ${sourcePath} declara modes: [${declaredModes.join(', ')}] pero no se pasó --mode=<x> ni hay default_mode`,
    );
  }

  if (!declaredModes.includes(activeMode)) {
    throw new Error(
      `--mode=${activeMode} no está en modes: [${declaredModes.join(', ')}] (definidos en ${sourcePath})`,
    );
  }

  // Clonar para no mutar el doc original.
  const out: Record<string, unknown> = { ...doc };

  // Sufijar name con el mode para permitir coexistencia de varios modes del
  // mismo stack levantados al mismo tiempo (containers/networks/volumes
  // namespacean por compose project name).
  if (typeof out.name === 'string') {
    out.name = `${out.name}-${activeMode}`;
  }

  // Filtrar services por service.modes y borrar el campo modes del service
  // (no debe llegar al schema final). Hace una copia del services map.
  if (isPlainObject(out.services)) {
    const newServices: Record<string, unknown> = {};
    for (const [svcName, svc] of Object.entries(out.services)) {
      if (!isPlainObject(svc)) {
        newServices[svcName] = svc;
        continue;
      }
      const svcModes = svc.modes;
      if (Array.isArray(svcModes)) {
        if (!svcModes.includes(activeMode)) continue; // excluido del mode activo
        const { modes: _m, ...rest } = svc;
        newServices[svcName] = rest;
      } else {
        newServices[svcName] = svc;
      }
    }
    out.services = newServices;
  }

  // Resolver {by_mode: {...}} recursivamente en TODO el doc (incluye vars,
  // common_env, gateway, services, etc).
  const final = walkResolveByMode(out, activeMode);

  // Cleanup del root: modes/default_mode no deben llegar al schema final.
  if (isPlainObject(final)) {
    const cleaned: Record<string, unknown> = { ...final };
    delete cleaned.modes;
    delete cleaned.default_mode;
    return { resolved: cleaned, activeMode, declaredModes: declaredModes.map(String) };
  }
  return { resolved: final, activeMode, declaredModes: declaredModes.map(String) };
}

// Resuelve recursivamente cualquier nodo con shape {by_mode: {<mode>: value}}
// al valor del mode activo. Si el mode no tiene key, el nodo se elimina
// (devuelve undefined → el caller lo filtra del objeto/array padre).
// Nodos sin by_mode pasan tal cual (recursivo).
function walkResolveByMode(node: unknown, mode: string): unknown {
  if (isPlainObject(node) && 'by_mode' in node && isPlainObject(node.by_mode)) {
    const picked = node.by_mode[mode];
    if (picked === undefined) return undefined;
    return walkResolveByMode(picked, mode);
  }
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      const r = walkResolveByMode(item, mode);
      if (r !== undefined) out.push(r);
    }
    return out;
  }
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const r = walkResolveByMode(v, mode);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return node;
}

function formatZodError(err: z.ZodError, source: string): string {
  const lines = err.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  return `stack inválido (${source}):\n${lines.join('\n')}`;
}

function deepMerge(target: any, source: any): any {
  if (isPlainObject(target) && isPlainObject(source)) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (isPlainObject(source[key])) {
        if (key in target) {
          result[key] = deepMerge(target[key], source[key]);
        } else {
          result[key] = source[key];
        }
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }
  return source;
}
