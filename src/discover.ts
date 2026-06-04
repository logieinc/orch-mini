import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

export const STACK_FILENAME = 'stack.yaml';
// Subdirs convencionales donde el stack.yaml puede vivir agrupado con archivos
// auxiliares (init scripts, certs, secrets). Si lo encuentra ahí, el padre se
// trata como workspaceRoot (donde van repos/ y .stack/).
export const STACK_SUBDIRS = ['arch'] as const;

export function findStack(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  const root = parse(dir).root;
  while (true) {
    for (const candidate of candidatesIn(dir)) {
      if (existsSync(candidate)) return candidate;
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function candidatesIn(dir: string): string[] {
  return [join(dir, STACK_FILENAME), ...STACK_SUBDIRS.map((s) => join(dir, s, STACK_FILENAME))];
}
