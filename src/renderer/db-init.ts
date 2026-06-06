import type { Stack } from '../schema.js';

export type DbInitFile = {
  path: string;           // relativo al outDir (.stack/)
  content: string;
  service: string;        // service postgres-like al que pertenece
  mountTarget: string;    // path adentro del container donde se monta
};

// Genera SQL scripts de "CREATE DATABASE" idempotente para cada service
// con databases:. Postgres NO soporta IF NOT EXISTS para DATABASE, así que
// usamos un bloque DO con consulta a pg_database.
export function renderDbInit(stack: Stack): DbInitFile[] {
  const files: DbInitFile[] = [];

  for (const [name, svc] of Object.entries(stack.services)) {
    if (!svc.databases || svc.databases.length === 0) continue;
    files.push({
      path: `db-init/${name}.sql`,
      content: renderPostgresInit(svc.databases),
      service: name,
      mountTarget: `/docker-entrypoint-initdb.d/00-om-databases.sql`,
    });
  }

  return files;
}

function renderPostgresInit(databases: string[]): string {
  const lines: string[] = ['-- Generado por om — CREATE DATABASE idempotente.'];
  for (const db of databases) {
    // Escape simple del identificador (alphanumeric + underscore + dash permitidos en pg).
    const safe = db.replace(/[^a-zA-Z0-9_-]/g, '');
    if (safe !== db) {
      throw new Error(
        `databases: nombre inválido '${db}' — solo se permiten [a-zA-Z0-9_-]`,
      );
    }
    lines.push(`SELECT 'CREATE DATABASE "${safe}"'`);
    lines.push(`WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${safe}')\\gexec`);
  }
  lines.push('');
  return lines.join('\n');
}
