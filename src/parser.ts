import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
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
  workDir: string;          // dirname(stack.yaml)
  workspaceRoot: string;    // donde van repos/ y .stack/ — padre del workDir si el yaml vive en arch/
  outDir: string;           // workspaceRoot/.stack
  locations: Locations;
};

export function loadStack(stackPath?: string): LoadedStack {
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
  const docPlain = docNode.toJSON();

  // Expandir ${file:path} antes de validar — paths se resuelven relativo al workDir.
  const expanded = expandFileRefs(docPlain, workDir);

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

  return {
    stack,
    sourcePath: absPath,
    workDir,
    workspaceRoot,
    outDir: resolve(workspaceRoot, '.stack'),
    locations,
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

function formatZodError(err: z.ZodError, source: string): string {
  const lines = err.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  return `stack inválido (${source}):\n${lines.join('\n')}`;
}
