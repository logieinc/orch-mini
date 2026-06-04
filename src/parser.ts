import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { expandFileRefs } from './file-refs.js';
import { findStack, STACK_FILENAME, STACK_SUBDIRS } from './discover.js';
import { stackSchema, type Stack } from './schema.js';

export type LoadedStack = {
  stack: Stack;
  sourcePath: string;
  workDir: string;          // dirname(stack.yaml)
  workspaceRoot: string;    // donde van repos/ y .stack/ — padre del workDir si el yaml vive en arch/
  outDir: string;           // workspaceRoot/.stack
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

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`YAML inválido en ${absPath}: ${msg}`);
  }

  const workDir = resolve(absPath, '..');

  // Expandir ${file:path} antes de validar — paths se resuelven relativo al workDir.
  const expanded = expandFileRefs(doc, workDir);

  // Normalizar el formato mixed de env (string | {value, description, required})
  // a dos campos planos: env (Record<string,string>) + env_meta (descripciones).
  const normalized = normalizeEnvMetadata(expanded);

  const result = stackSchema.safeParse(normalized);
  if (!result.success) {
    throw new Error(formatZodError(result.error, absPath));
  }

  const workspaceRoot = computeWorkspaceRoot(workDir);

  return {
    stack: result.data,
    sourcePath: absPath,
    workDir,
    workspaceRoot,
    outDir: resolve(workspaceRoot, '.stack'),
  };
}

function computeWorkspaceRoot(workDir: string): string {
  // Si el stack.yaml vive en un subdir convencional (arch/), el workspaceRoot
  // es el padre — repos/ y .stack/ no se mezclan con la definición.
  if ((STACK_SUBDIRS as readonly string[]).includes(basename(workDir))) {
    return dirname(workDir);
  }
  return workDir;
}

// Recorre stack.services.*.env y si algún valor es un objeto con shape
// { value, description?, required? }, splittea: env[k] = String(value),
// env_meta[k] = { description?, required? }. Los valores que ya son string,
// number o boolean pasan tal cual.
function normalizeEnvMetadata(doc: unknown): unknown {
  if (!isPlainObject(doc)) return doc;
  const services = isPlainObject(doc.services) ? doc.services : undefined;
  if (!services) return doc;

  const newServices: Record<string, unknown> = {};
  for (const [svcName, svc] of Object.entries(services)) {
    if (!isPlainObject(svc) || !isPlainObject(svc.env)) {
      newServices[svcName] = svc;
      continue;
    }
    const env: Record<string, unknown> = {};
    const env_meta: Record<string, { description?: string; required?: boolean }> = {};
    for (const [k, v] of Object.entries(svc.env)) {
      if (isPlainObject(v) && ('value' in v || 'description' in v || 'required' in v)) {
        env[k] = v.value ?? '';
        const meta: { description?: string; required?: boolean } = {};
        if (typeof v.description === 'string') meta.description = v.description;
        if (typeof v.required === 'boolean') meta.required = v.required;
        if (Object.keys(meta).length > 0) env_meta[k] = meta;
      } else {
        env[k] = v;
      }
    }
    const newSvc: Record<string, unknown> = { ...svc, env };
    if (Object.keys(env_meta).length > 0) newSvc.env_meta = env_meta;
    newServices[svcName] = newSvc;
  }

  return { ...doc, services: newServices };
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
