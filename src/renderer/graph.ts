import type { Stack } from '../schema.js';

export function renderMermaid(stack: Stack): string {
  const lines: string[] = ['flowchart TD'];

  // 1. Estilos y clases de Mermaid para que se vea premium
  lines.push('  classDef gateway fill:#e1f5fe,stroke:#03a9f4,stroke-width:2px,color:#01579b;');
  lines.push('  classDef service fill:#efebe9,stroke:#8d6e63,stroke-width:2px,color:#3e2723;');
  lines.push('  classDef db fill:#e8f5e9,stroke:#4caf50,stroke-width:2px,color:#1b5e20;');
  lines.push('  classDef oneshot fill:#f3e5f5,stroke:#9c27b0,stroke-width:2px,color:#4a148c;');
  lines.push('');

  // 2. Definición del Gateway si existe
  if (stack.gateway) {
    lines.push('  %% Gateway & Routes');
    lines.push(`  Gateway["🌐 Gateway\\nPort: ${stack.gateway.port}"]:::gateway`);
    for (const route of stack.gateway.routes) {
      const authLabel = route.auth ? ` 🔒 [Auth: ${route.auth.service}]` : '';
      const stripPrefixLabel = route.strip_prefix ? ' [Strip]' : '';
      lines.push(`  Gateway -->|"${route.path}${authLabel}${stripPrefixLabel}"| ${route.service}`);
    }
    lines.push('');
  }

  // 3. Definición de los servicios
  lines.push('  %% Services');
  for (const [name, svc] of Object.entries(stack.services)) {
    const isDb = svc.image && /^postgres(:|$)/i.test(svc.image);
    const dbIcon = isDb ? '🗄️ ' : '📦 ';
    const kindLabel = svc.kind === 'oneshot' ? ' (Oneshot)' : '';
    
    // Armar puerto de exposición si está declarado
    const exposePortLabel = svc.expose_host ? `\\nExposed Host Port: ${svc.expose_host}` : '';
    const internalPortLabel = svc.port ? `\\nInternal Port: ${svc.port}` : '';
    
    const nodeClass = svc.kind === 'oneshot' ? 'oneshot' : (isDb ? 'db' : 'service');
    
    lines.push(`  ${name}["${dbIcon}${name}${kindLabel}${internalPortLabel}${exposePortLabel}"]:::${nodeClass}`);
  }
  lines.push('');

  // 4. Conexiones y dependencias (needs)
  lines.push('  %% Dependencies');
  for (const [name, svc] of Object.entries(stack.services)) {
    for (const dep of svc.needs ?? []) {
      const depName = typeof dep === 'string' ? dep : dep.service;
      let condLabel = '';
      if (typeof dep === 'object' && dep.condition) {
        condLabel = `[${dep.condition}]`;
      } else {
        // Si el dependiente tiene healthcheck, por defecto el condLabel se puede inferir
        const depSvc = stack.services[depName];
        if (depSvc && depSvc.healthcheck) {
          condLabel = '[service_healthy]';
        }
      }
      if (condLabel) {
        lines.push(`  ${name} -->|"${condLabel}"| ${depName}`);
      } else {
        lines.push(`  ${name} --> ${depName}`);
      }
    }
  }
  lines.push('');

  // 5. Bases de datos declarativas inyectadas
  let hasDbs = false;
  for (const [name, svc] of Object.entries(stack.services)) {
    if (svc.databases && svc.databases.length > 0) {
      if (!hasDbs) {
        lines.push('  %% Logical Databases');
        hasDbs = true;
      }
      for (const dbName of svc.databases) {
        const dbNodeId = `Db_${name}_${dbName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        lines.push(`  ${dbNodeId}["💾 DB: ${dbName}"]:::db`);
        lines.push(`  ${name} ==> ${dbNodeId}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}
