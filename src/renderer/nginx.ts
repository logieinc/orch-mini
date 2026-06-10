import type { Stack } from '../schema.js';

export function renderNginx(stack: Stack): string {
  if (!stack.gateway) return '';

  const usedServices = new Set(stack.gateway.routes.map((r) => r.service));
  // Los services usados como auth también necesitan upstream declarado.
  const authServices = new Set<string>();
  for (const route of stack.gateway.routes) {
    if (route.auth) {
      usedServices.add(route.auth.service);
      authServices.add(route.auth.service);
    }
  }

  const upstreams = [...usedServices]
    .map((svcName) => {
      const svc = stack.services[svcName]!;
      return `upstream ${svcName} {\n    server ${svcName}:${svc.port};\n}`;
    })
    .join('\n\n');

  // Orden por especificidad (longitud del path) — más largo gana. nginx hace
  // longest-prefix match nativo, pero ordenar mantiene el archivo legible.
  const sortedRoutes = [...stack.gateway.routes].sort(
    (a, b) => effectivePathLength(b.path) - effectivePathLength(a.path),
  );

  // Subrequests internos para auth_request — uno por service auth. nginx
  // los invoca via `auth_request /_om_auth_<svc>` y capta el header
  // `x_decoded_token` de la response.
  const authLocations = [...authServices].map((svc) => renderAuthLocation(svc)).join('\n\n');

  const locations = sortedRoutes.map((route) => renderLocation(route)).join('\n\n');

  const serverName = stack.gateway.server_name ?? '_';

  return `# Generado por om — no editar a mano
worker_processes 1;

events {
    worker_connections 1024;
}

http {
    sendfile on;
    keepalive_timeout 65;
    client_max_body_size 50m;

${indent(upstreams, 4)}

    server {
        listen 80;
        server_name ${serverName};

${authLocations}${authLocations ? '\n\n' : ''}${locations}
    }
}
`;
}

function renderAuthLocation(authService: string): string {
  // Convención: el authorizer expone su endpoint en `/<svc-name>` (e.g. el
  // repo `authorizer` declara `server.get('/authorizer', ...)`) y recibe la
  // request original a validar via headers X-Real-Uri / X-Real-Method.
  // Responde 2xx con header `x_decoded_token` si está autorizado; las routes
  // protegidas capturan ese header con `auth_request_set` y lo forwardean
  // como `x-auth-decoded-token` al upstream.
  const directives = [
    `internal;`,
    `proxy_pass http://${authService}/${authService};`,
    `proxy_pass_request_body off;`,
    `proxy_set_header Content-Length "";`,
    `proxy_set_header Host $host;`,
    `proxy_set_header X-Real-Uri $request_uri;`,
    `proxy_set_header X-Real-Method $request_method;`,
    `proxy_set_header Authorization $http_authorization;`,
    `proxy_set_header Cookie $http_cookie;`,
    `proxy_set_header X-Api-Key $http_x_api_key;`,
  ];
  const body = directives.map((l) => `            ${l}`).join('\n');
  return `        location = /_om_auth_${authService} {\n${body}\n        }`;
}

function renderLocation(route: {
  path: string;
  service: string;
  strip_prefix?: boolean;
  rewrite?: string;
  auth?: { service: string };
}): string {
  const directives: string[] = [];

  if (route.auth) {
    // auth_request_set captura el header `x_decoded_token` de la response
    // del authorizer y lo expone como variable; luego lo renombramos a
    // `x-auth-decoded-token` (el header que los guards consumen — e.g.
    // RestrictedGuard en api-wallet).
    directives.push(
      `auth_request /_om_auth_${route.auth.service};`,
      `auth_request_set $om_decoded_token $upstream_http_x_decoded_token;`,
      `proxy_set_header x-auth-decoded-token $om_decoded_token;`,
    );
  }

  if (route.rewrite) {
    directives.push(`rewrite ${route.rewrite};`);
  } else if (route.strip_prefix) {
    // /provider-api/foo → /foo
    const prefix = route.path.replace(/^=\s*/, '').replace(/\/$/, '');
    if (prefix.length > 0) {
      directives.push(`rewrite ^${prefix}/(.*)$ /$1 break;`);
    }
  }

  directives.push(
    `proxy_pass http://${route.service};`,
    `proxy_http_version 1.1;`,
    `proxy_set_header Host $host;`,
    `proxy_set_header X-Real-IP $remote_addr;`,
    `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `proxy_set_header X-Forwarded-Proto $scheme;`,
    `proxy_set_header Upgrade $http_upgrade;`,
    `proxy_set_header Connection "upgrade";`,
  );

  const body = directives.map((l) => `            ${l}`).join('\n');
  return `        location ${route.path} {\n${body}\n        }`;
}

function effectivePathLength(path: string): number {
  // Para ordenamiento: ignorar modificador "= " o "^~ " del prefix.
  return path.replace(/^(=|\^~)\s*/, '').length;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}
