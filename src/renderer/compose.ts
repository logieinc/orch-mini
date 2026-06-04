import { stringify as stringifyYaml } from 'yaml';
import { repoSlug } from '../repo.js';
import { hasBuild, type Stack } from '../schema.js';
import { renderDbInit } from './db-init.js';

const REPOS_DIR_VAR = '${REPOS_DIR}';

export function renderCompose(stack: Stack): string {
  const services: Record<string, unknown> = {};
  const namedVolumes = new Set<string>();

  // Pre-calcular qué services son oneshot — necesario para decidir el formato
  // de depends_on cuando otros services los referencian.
  const oneshotSet = new Set(
    Object.entries(stack.services)
      .filter(([, svc]) => svc.kind === 'oneshot')
      .map(([name]) => name),
  );

  // db-init: auto-mount de scripts SQL para services postgres con databases:.
  const dbInitFiles = renderDbInit(stack);
  const dbInitByService = new Map(dbInitFiles.map((f) => [f.service, f]));

  for (const [name, svc] of Object.entries(stack.services)) {
    const entry: Record<string, unknown> = {
      container_name: `${stack.name}-${name}`,
    };

    if (hasBuild(svc)) {
      entry.build = {
        context: `${REPOS_DIR_VAR}/${repoSlug(svc.repo!)}`,
        dockerfile: svc.build,
      };
    } else {
      entry.image = svc.image;
    }

    if (svc.working_dir !== undefined) {
      entry.working_dir = svc.working_dir;
    }

    if (svc.port !== undefined) {
      entry.expose = [String(svc.port)];
    }

    const ports: string[] = [];
    if (svc.expose_host !== undefined && svc.port !== undefined) {
      ports.push(`${svc.expose_host}:${svc.port}`);
    }
    if (svc.debug_port !== undefined) ports.push(`${svc.debug_port}:${svc.debug_port}`);
    if (ports.length > 0) entry.ports = ports;

    const environment: Record<string, string> = { ...(svc.env ?? {}) };
    if (svc.debug_port !== undefined) {
      const inspectFlag = `--inspect=0.0.0.0:${svc.debug_port}`;
      environment.NODE_OPTIONS = environment.NODE_OPTIONS
        ? `${environment.NODE_OPTIONS} ${inspectFlag}`
        : inspectFlag;
    }
    if (Object.keys(environment).length > 0) {
      entry.environment = environment;
    }

    // Volumes — combinar declarados + auto-mount del db-init si aplica.
    const volumes: string[] = [...(svc.volumes ?? [])];
    const dbInit = dbInitByService.get(name);
    if (dbInit) {
      volumes.push(`./${dbInit.path}:${dbInit.mountTarget}:ro`);
    }
    if (volumes.length > 0) {
      entry.volumes = volumes;
      for (const v of volumes) {
        const namedVol = extractNamedVolume(v);
        if (namedVol) namedVolumes.add(namedVol);
      }
    }

    if (svc.command !== undefined) {
      entry.command = svc.command;
    }

    if (svc.needs && svc.needs.length > 0) {
      entry.depends_on = renderDependsOn(svc.needs, oneshotSet);
    }

    entry.networks = ['default'];
    // oneshot: corre una vez y termina sin restartear.
    entry.restart = svc.kind === 'oneshot' ? 'no' : 'unless-stopped';

    services[name] = entry;
  }

  if (stack.gateway) {
    services.gateway = renderGatewayService(stack, oneshotSet);
  }

  const compose: Record<string, unknown> = {
    name: stack.name,
    services,
    networks: {
      default: { name: `${stack.name}_default` },
    },
  };

  if (namedVolumes.size > 0) {
    compose.volumes = Object.fromEntries(
      [...namedVolumes].sort().map((n) => [n, { name: `${stack.name}_${n}` }]),
    );
  }

  return stringifyYaml(compose, { lineWidth: 0 });
}

function renderDependsOn(needs: string[], oneshotSet: Set<string>): unknown {
  // Si TODOS los needs son services normales, formato array (más simple/legible).
  // Si alguno es oneshot, usar formato objeto extendido para poder declarar
  // condition: service_completed_successfully en los oneshots.
  const hasOneshot = needs.some((n) => oneshotSet.has(n));
  if (!hasOneshot) return [...needs];

  const out: Record<string, { condition: string }> = {};
  for (const n of needs) {
    out[n] = {
      condition: oneshotSet.has(n) ? 'service_completed_successfully' : 'service_started',
    };
  }
  return out;
}

function renderGatewayService(
  stack: Stack,
  oneshotSet: Set<string>,
): Record<string, unknown> {
  const targets = [...new Set(stack.gateway!.routes.map((r) => r.service))];
  return {
    container_name: `${stack.name}-gateway`,
    image: 'nginx:1.27-alpine',
    ports: [`${stack.gateway!.port}:80`],
    volumes: ['./nginx.conf:/etc/nginx/nginx.conf:ro'],
    depends_on: renderDependsOn(targets, oneshotSet),
    networks: ['default'],
    restart: 'unless-stopped',
  };
}

function extractNamedVolume(spec: string): string | null {
  const colonIdx = spec.indexOf(':');
  if (colonIdx <= 0) return null;
  const left = spec.slice(0, colonIdx);
  if (left.startsWith('/') || left.startsWith('.') || left.includes('$')) return null;
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(left)) return null;
  return left;
}
