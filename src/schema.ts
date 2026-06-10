import { z } from 'zod';

const serviceNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_-]*$/, 'service name debe ser kebab/snake-case y empezar con letra');

// Nombre de un mode (p.ej. "local", "cloud"). Mismo formato que stack name.
const modeNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9-]*$/, 'mode debe ser kebab-case y empezar con letra');

const taskNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9-]*$/, 'task name debe ser kebab-case y empezar con letra');

// Built-in subcomandos de `om` — un task con cualquiera de estos nombres
// haría que el comando deje de funcionar. La lista la valida el schema
// (no se importa desde cli.ts para evitar el ciclo).
const RESERVED_TASK_NAMES = new Set([
  'init', 'sync', 'gen', 'validate', 'info', 'vscode',
  'up', 'down', 'stop', 'restart', 'build', 'logs', 'ps',
  'help', 'version',
]);

const taskSchema = z.object({
  description: z.string().min(1),
  run: z.string().min(1),
});

const envValueSchema = z.union([z.string(), z.number(), z.boolean()]).transform(String);
const envMapSchema = z.record(z.string(), envValueSchema);

// Metadata opcional por env var: description + required + from_common.
// El parser pre-normaliza el formato mixed (string vs {value,description,required})
// dejando `env` como Record<string,string> y `env_meta` como esta estructura.
// from_common lo agrega el parser cuando la var fue mergeada desde stack.common_env.
const envMetaEntrySchema = z.object({
  description: z.string().optional(),
  required: z.boolean().optional(),
  from_common: z.boolean().optional(),
});
const envMetaMapSchema = z.record(z.string(), envMetaEntrySchema);

// auth: delega validación de cada request al servicio nombrado vía nginx
// `auth_request`. El servicio auth debe responder 2xx en /authorizer y emitir
// el header `x_decoded_token` con el contexto decodificado — el gateway lo
// renombra a `x-auth-decoded-token` antes de proxyar al upstream (convención
// del stack: authorizer emite `x_decoded_token`, los services lo consumen
// como `x-auth-decoded-token`).
const routeAuthSchema = z.object({
  service: serviceNameSchema,
});

const routeSchema = z.object({
  path: z.string().min(1),
  service: serviceNameSchema,
  strip_prefix: z.boolean().optional(),
  rewrite: z.string().optional(),
  auth: routeAuthSchema.optional(),
});

const gatewaySchema = z.object({
  port: z.number().int().positive(),
  server_name: z.string().optional(),
  routes: z.array(routeSchema).min(1),
});

const vscodeBrowserSchema = z.object({
  url: z.string().optional(),
  label: z.string().optional(),
});

const vscodeServiceSchema = z.object({
  browser: vscodeBrowserSchema.optional(),
});

// Una entrada de service única. `image` y `build` son mutuamente excluyentes
// pero al menos uno tiene que estar. `repo` es opcional para ambos (sirve a sync).
// Para oneshot, `port` también es opcional (jobs efímeros no escuchan).
const serviceSchema = z
  .object({
    kind: z.enum(['service', 'oneshot']).default('service'),
    // Lista de modes en los que este service participa. Si está ausente, el
    // service va en TODOS los modes (default). El parser filtra los services
    // cuyo `modes:` no incluye el mode activo ANTES de validar con este
    // schema — a esta altura el campo ya fue removido por el pre-proceso.
    // Se declara opcional acá solo para que el doc raw lo acepte; nunca debe
    // sobrevivir a la validación.
    modes: z.array(modeNameSchema).optional(),
    image: z.string().optional(),
    build: z.string().optional(),
    repo: z.string().optional(),
    ref: z.string().optional(),
    working_dir: z.string().optional(),
    port: z.number().int().positive().optional(),
    debug_port: z.number().int().positive().optional(),
    env: envMapSchema.optional(),
    env_meta: envMetaMapSchema.optional(),
    needs: z.array(serviceNameSchema).optional(),
    expose_host: z.number().int().positive().optional(),
    volumes: z.array(z.string()).optional(),
    // Lista de directorios que el renderer "shadow-ea" con named volumes para
    // que no atraviesen el bind mount del repo (i.e. cruzar VirtioFS host↔VM
    // en Mac es lento, y los binarios nativos de node_modules son por-OS).
    // Solo aplica si el service tiene un bind mount ${REPOS_DIR}/X:<working_dir>.
    // - undefined: usa defaults (node_modules, .next, dist, build, .turbo)
    // - []: opt-out total
    // - lista custom: reemplaza los defaults
    // Si el dev declaró manualmente un volume cuyo target coincide con
    // <working_dir>/<dir>, no se duplica.
    shadow_dirs: z.array(z.string().min(1)).optional(),
    command: z.union([z.string(), z.array(z.string())]).optional(),
    databases: z.array(z.string().min(1)).optional(),
    vscode: vscodeServiceSchema.optional(),
  })
  .superRefine((svc, ctx) => {
    const hasImage = svc.image !== undefined;
    const hasBuild = svc.build !== undefined;
    if (hasImage === hasBuild) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: hasImage
          ? 'no pueden coexistir image: y build: en el mismo service'
          : 'el service necesita image: o build:',
      });
    }
    if (hasBuild && svc.repo === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repo'],
        message: 'build: requiere repo: para resolver el build context',
      });
    }
    if (svc.kind === 'service' && svc.port === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['port'],
        message: 'port: es obligatorio para kind: service (omitilo solo en kind: oneshot)',
      });
    }
    if (svc.databases !== undefined && svc.databases.length > 0) {
      const img = svc.image ?? '';
      if (!/^postgres(:|$)/i.test(img)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['databases'],
          message: `databases: solo soportado en image: postgres (recibido: ${img || '(none)'})`,
        });
      }
    }
  });

export const stackSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, 'name debe ser kebab-case y empezar con letra'),
    // Modes declarados. Si está presente, el dev DEBE pasar --mode=<x> al
    // generar (o setear default_mode). El parser sufija el `name` final con
    // el mode (p.ej. name: stage-om + mode: local → stage-om-local) para que
    // ambos modes puedan coexistir levantados.
    modes: z.array(modeNameSchema).min(1).optional(),
    default_mode: modeNameSchema.optional(),
    gateway: gatewaySchema.optional(),
    // Variables de plantilla para el stack. Se escriben al .env (al lado de
    // REPOS_DIR, STACK_DIR) y docker compose las interpola en cualquier ${VAR}
    // del docker-compose.yaml. Útil para no repetir un valor (dominio público,
    // versión de imagen, etc) en N lugares del yaml.
    vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String)).optional(),
    // Vars compartidas: se auto-inyectan a TODOS los services. Si un service
    // declara la misma var en su env:, gana el del service.
    common_env: envMapSchema.optional(),
    common_env_meta: envMetaMapSchema.optional(),
    services: z
      .record(serviceNameSchema, serviceSchema)
      .refine((s) => Object.keys(s).length > 0, { message: 'el stack debe tener al menos un service' }),
    // Tareas operativas del stack — scripts/comandos que el dev quiere
    // invocar a demanda (no son parte del runtime declarativo). Cada task
    // se ejecuta como `om <task-name> [args...]` con cwd = workspaceRoot
    // (el dir del stack.yaml), heredando el entorno y stdio del padre.
    tasks: z.record(taskNameSchema, taskSchema).optional(),
  })
  .superRefine((stack, ctx) => {
    const names = new Set(Object.keys(stack.services));

    if (stack.gateway) {
      for (const [i, route] of stack.gateway.routes.entries()) {
        if (!names.has(route.service)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['gateway', 'routes', i, 'service'],
            message: `route apunta a service inexistente: ${route.service}`,
          });
        }
        if (route.auth && !names.has(route.auth.service)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['gateway', 'routes', i, 'auth', 'service'],
            message: `auth.service apunta a service inexistente: ${route.auth.service}`,
          });
        }
      }
    }

    for (const [svcName, svc] of Object.entries(stack.services)) {
      for (const [i, dep] of (svc.needs ?? []).entries()) {
        if (!names.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['services', svcName, 'needs', i],
            message: `needs apunta a service inexistente: ${dep}`,
          });
        }
        if (dep === svcName) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['services', svcName, 'needs', i],
            message: `un service no puede depender de sí mismo`,
          });
        }
      }
    }

    const hostPorts = new Map<number, string[]>();
    if (stack.gateway) hostPorts.set(stack.gateway.port, ['gateway']);
    for (const [svcName, svc] of Object.entries(stack.services)) {
      if (svc.expose_host !== undefined) {
        const list = hostPorts.get(svc.expose_host) ?? [];
        list.push(svcName);
        hostPorts.set(svc.expose_host, list);
      }
      if (svc.debug_port !== undefined) {
        const list = hostPorts.get(svc.debug_port) ?? [];
        list.push(`${svcName}.debug_port`);
        hostPorts.set(svc.debug_port, list);
      }
    }
    for (const [port, owners] of hostPorts) {
      if (owners.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['services'],
          message: `puerto host ${port} reclamado por: ${owners.join(', ')}`,
        });
      }
    }

    for (const taskName of Object.keys(stack.tasks ?? {})) {
      if (RESERVED_TASK_NAMES.has(taskName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', taskName],
          message: `task '${taskName}' colisiona con un subcomando built-in de om`,
        });
      }
    }

    // default_mode: si está, debe estar en la lista de modes declarados.
    if (stack.default_mode !== undefined) {
      if (!stack.modes || !stack.modes.includes(stack.default_mode)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['default_mode'],
          message: `default_mode '${stack.default_mode}' no está en modes: [${(stack.modes ?? []).join(', ')}]`,
        });
      }
    }
  });

export type Stack = z.infer<typeof stackSchema>;
export type Service = Stack['services'][string];

export function hasBuild(svc: Service): boolean {
  return svc.build !== undefined;
}

export function hasRepo(svc: Service): svc is Service & { repo: string } {
  return typeof svc.repo === 'string' && svc.repo.length > 0;
}
