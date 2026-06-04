import { z } from 'zod';

const serviceNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_-]*$/, 'service name debe ser kebab/snake-case y empezar con letra');

const envValueSchema = z.union([z.string(), z.number(), z.boolean()]).transform(String);
const envMapSchema = z.record(z.string(), envValueSchema);

// Metadata opcional por env var: description + required.
// El parser pre-normaliza el formato mixed (string vs {value,description,required})
// dejando `env` como Record<string,string> y `env_meta` como esta estructura.
const envMetaEntrySchema = z.object({
  description: z.string().optional(),
  required: z.boolean().optional(),
});
const envMetaMapSchema = z.record(z.string(), envMetaEntrySchema);

const routeSchema = z.object({
  path: z.string().min(1),
  service: serviceNameSchema,
  strip_prefix: z.boolean().optional(),
  rewrite: z.string().optional(),
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
    gateway: gatewaySchema.optional(),
    services: z
      .record(serviceNameSchema, serviceSchema)
      .refine((s) => Object.keys(s).length > 0, { message: 'el stack debe tener al menos un service' }),
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
  });

export type Stack = z.infer<typeof stackSchema>;
export type Service = Stack['services'][string];

export function hasBuild(svc: Service): boolean {
  return svc.build !== undefined;
}

export function hasRepo(svc: Service): svc is Service & { repo: string } {
  return typeof svc.repo === 'string' && svc.repo.length > 0;
}
