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
  ];

  // Vars de plantilla declaradas en stack.vars — docker compose las interpola
  // en cualquier ${VAR} del docker-compose.yaml.
  if (stack.vars && Object.keys(stack.vars).length > 0) {
    lines.push('');
    lines.push('# stack.vars');
    for (const [key, value] of Object.entries(stack.vars)) {
      lines.push(`${key}=${value}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
