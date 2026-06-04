import type { Stack } from '../schema.js';

export function renderEnv(
  stack: Stack,
  opts: { reposDir: string; stackDir: string },
): string {
  const lines: string[] = [
    '# Generado por om — interpolado por docker compose.',
    `COMPOSE_PROJECT_NAME=${stack.name}`,
    `REPOS_DIR=${opts.reposDir}`,
    `STACK_DIR=${opts.stackDir}`,
    '',
  ];
  return lines.join('\n');
}
