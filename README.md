# om

Orquestador declarativo mínimo: un `stack.yaml` describe la arquitectura, el CLI renderiza `docker-compose.yaml` + `nginx.conf` + scripts y levanta el stack.

Pensado para stacks chicos donde el orch completo (engine + launcher + profiles + SOPS + k8s + …) es demasiada maquinaria.

## Requisitos

- Node 18+ (Mac / Linux / Windows)
- Docker Desktop o Docker Engine + Compose plugin

## Instalación

```bash
npm install
npm link               # registra el comando `om` globalmente
```

Funciona igual en Mac, Linux y Windows — `npm link` crea el wrapper apropiado por OS.

## Layout del proyecto

```
mi-app/
├── arch/                       # toda la definición de arquitectura
│   ├── stack.yaml
│   ├── init/                   # archivos auxiliares montados como volúmenes
│   ├── certs/                  # claves públicas .pem (versionables)
│   └── secrets/                # claves privadas .pem (gitignored)
├── repos/                      # gitignored (clones de los repos del stack)
└── .stack/                     # gitignored (output del gen)
```

`om` reconoce `arch/stack.yaml` automáticamente — `repos/` y `.stack/` se anclan al padre. También se puede tener `stack.yaml` en la raíz directamente (sin `arch/`), si el stack es muy simple.

## Flujo end-to-end

```bash
mkdir mi-app && cd mi-app
om init                # crea arch/stack.yaml + arch/{init,certs,secrets}/
om sync                # clone/pull de los repos declarados → repos/
om gen                 # render → .stack/
om up                  # docker compose up -d
om logs api            # seguir logs del service api
om stop                # parar sin remove
om restart api         # reiniciar un service
om down                # tear down completo
```

Sin path explícito, `om` busca el `stack.yaml` más cercano subiendo desde la carpeta actual.

## Inyectar archivos en env vars

Para PEMs, certs, secrets o cualquier archivo cuyo contenido tenga que ir en una env var del container:

```yaml
services:
  api:
    env:
      CHAT_OS_SIGNING_PRIVATE_KEY_PEM: ${file:secrets/chat-os-signing-private.pem}
      CHAT_OS_PUBLIC_KEY_PEM: ${file:certs/chat-os-signing-public.pem}
```

El path es relativo al `stack.yaml`. El contenido se inline al `environment:` del container en tiempo de render.

## Crear DBs declarativamente

Para services postgres, listá las DBs lógicas en `databases:`. `om` genera un script SQL idempotente y lo auto-monta en `/docker-entrypoint-initdb.d/`:

```yaml
services:
  chat-os-db:
    image: postgres:16-alpine
    port: 5432
    env:
      POSTGRES_USER: chat_os
      POSTGRES_PASSWORD: chat_os
    databases:
      - chat_os_dev
      - chat_os_implementation_dev
```

**Limitación**: postgres solo ejecuta `/docker-entrypoint-initdb.d/` cuando el data volume está vacío. Si más adelante agregás una DB nueva al stack y el volume ya existe, el script no se va a ejecutar. Para ese caso, usar `kind: oneshot` (ver abajo).

## Init jobs con `kind: oneshot`

Un service `oneshot` corre una vez, termina, y los services que lo necesitan esperan a que termine OK antes de arrancar (vía docker compose `service_completed_successfully`).

Útil para: seeds de DB, migraciones one-shot, crear DBs en un postgres pre-existente, etc.

```yaml
services:
  chat-os-db:
    image: postgres:16-alpine
    ...

  chat-os-db-bootstrap:
    kind: oneshot
    image: postgres:16-alpine
    needs: [chat-os-db]
    command:
      - sh
      - -c
      - |
        until pg_isready -h chat-os-db -U chat_os; do sleep 1; done
        psql -h chat-os-db -U chat_os -d postgres -tc \
          "SELECT 1 FROM pg_database WHERE datname='extra_db'" | grep -q 1 \
          || psql -h chat-os-db -U chat_os -d postgres -c "CREATE DATABASE extra_db"
    env:
      PGPASSWORD: chat_os

  # otros services que dependen de la DB ya bootstrap-eada:
  app:
    image: node:20
    needs: [chat-os-db-bootstrap]   # espera service_completed_successfully
    ...
```

## Montar archivos como volúmenes

Para init scripts u otros archivos que el container espera leer del filesystem (ej `/docker-entrypoint-initdb.d/`), usar `${STACK_DIR}` que apunta al dir del `stack.yaml`:

```yaml
services:
  db:
    image: postgres:16
    volumes:
      - ${STACK_DIR}/init/init-dbs.sql:/docker-entrypoint-initdb.d/01-init.sql:ro
```

## Comandos

| comando | descripción |
|---|---|
| `init` | crea `stack.yaml` template en la carpeta actual |
| `sync` | clone/pull de los repos declarados en `services.*.repo` |
| `gen [path] [--out dir]` | rinde `docker-compose.yaml` + `nginx.conf` + scripts en `.stack/` |
| `validate [path]` | solo valida el schema del stack |
| `up [args]` | `docker compose up -d` |
| `down [args]` | `docker compose down` (remueve containers) |
| `stop [args]` | `docker compose stop` (preserva containers) |
| `restart [svc]` | `docker compose restart` |
| `build [svc]` | `docker compose build` |
| `logs [svc]` | `docker compose logs -f --tail=200` |
| `ps` | `docker compose ps` |

## Forma del stack.yaml

```yaml
name: mi-app
gateway:
  port: 8080
  routes:
    - path: /api
      service: api
    - path: /
      service: web

services:
  api:
    repo: github.com/me/api
    build: ./Dockerfile
    port: 3000
    env:
      DATABASE_URL: postgres://db:5432/app
    needs: [db]

  web:
    repo: github.com/me/web
    build: ./Dockerfile
    port: 3001
    env:
      API_URL: http://api:3000

  db:
    image: postgres:16
    port: 5432
    expose_host: 5433
    env:
      POSTGRES_DB: app
      POSTGRES_PASSWORD: app
```

## Output (en `.stack/`)

- `docker-compose.yaml` — listo para `docker compose up`
- `nginx.conf` — gateway con upstreams resueltos (si declaraste `gateway`)
- `.env` — vars que el compose interpola
- `scripts/<svc>.sh` y `scripts/<svc>.ps1` — correr el módulo nativo (sin docker), con env apuntando al resto del stack. Bash para Mac/Linux, PowerShell para Windows.

Para acciones sobre el stack entero (`up`, `down`, `logs`, `ps`) usá el CLI directamente — funciona igual en los tres OS.
