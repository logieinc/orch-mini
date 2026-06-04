import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATE = `# stack.yaml — describí la arquitectura acá, después corré: om sync && om gen && om up
#
# Layout: este archivo vive en arch/stack.yaml. om reconoce arch/ automáticamente —
# repos/ y .stack/ quedan en el padre.
#   arch/
#   ├── stack.yaml       (este archivo)
#   ├── init/            (archivos auxiliares montados como volúmenes, ej init scripts de DB)
#   ├── certs/           (claves públicas .pem versionables, leídas con \${file:certs/...})
#   └── secrets/         (claves privadas .pem gitignored, leídas con \${file:secrets/...})

name: mi-stack

# gateway: opcional. Si lo declarás, om levanta nginx y rutea por path.
# Quitalo si tu stack no necesita un proxy.
gateway:
  port: 8080
  routes:
    - path: /api
      service: api
    - path: /
      service: web

services:
  api:
    repo: github.com/me/api          # se clona en repos/api con 'om sync'
    build: ./Dockerfile
    port: 3000
    env:
      DATABASE_URL: postgres://app:app@db:5432/app
      # Referencias a otros services por nombre: el container "db" resuelve internamente.
    needs:
      - db

  web:
    repo: github.com/me/web
    build: ./Dockerfile
    port: 3001
    env:
      API_URL: http://api:3000
      # Para hablar desde el browser pasá por el gateway:
      PUBLIC_API_URL: http://localhost:8080/api

  db:
    image: postgres:16-alpine
    port: 5432
    expose_host: 5433                # opcional: publicar al host (psql -h localhost -p 5433)
    env:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
    volumes:
      - mi-stack-db:/var/lib/postgresql/data
`;

const SECRETS_GITIGNORE = `# Las claves privadas no se commitean. Solo este archivo queda en git.
*
!.gitignore
`;

const ROOT_GITIGNORE = `repos/
.stack/
`;

export function initStack(targetDir: string): { path: string; created: boolean; message: string } {
  const archDir = join(targetDir, 'arch');
  const target = join(archDir, 'stack.yaml');
  if (existsSync(target)) {
    return { path: target, created: false, message: `ya existe ${target}` };
  }

  mkdirSync(join(archDir, 'init'), { recursive: true });
  mkdirSync(join(archDir, 'certs'), { recursive: true });
  mkdirSync(join(archDir, 'secrets'), { recursive: true });

  writeFileSync(target, TEMPLATE);
  writeFileSync(join(archDir, 'secrets', '.gitignore'), SECRETS_GITIGNORE);

  const rootGitignore = join(targetDir, '.gitignore');
  if (!existsSync(rootGitignore)) {
    writeFileSync(rootGitignore, ROOT_GITIGNORE);
  }

  return {
    path: target,
    created: true,
    message: `creado ${target} y arch/{init,certs,secrets}/ — editá el yaml y corré 'om sync && om gen && om up'`,
  };
}
