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

  const result = stackSchema.safeParse(expanded);
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

function formatZodError(err: z.ZodError, source: string): string {
  const lines = err.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  return `stack inválido (${source}):\n${lines.join('\n')}`;
}
