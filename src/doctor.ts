import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { loadStack, type LoadedStack } from './parser.js';
import { hasRepo } from './schema.js';
import { repoSlug } from './repo.js';

const COLOR_ENABLED = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = (code: string, text: string): string =>
  COLOR_ENABLED ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = (t: string) => c('1', t);
const dim = (t: string) => c('2', t);
const yellow = (t: string) => c('33', t);
const magenta = (t: string) => c('35', t);
const green = (t: string) => c('32', t);
const red = (t: string) => c('31', t);

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolvePort(false);
      } else {
        resolvePort(true);
      }
    });
    server.once('listening', () => {
      server.close(() => {
        resolvePort(true);
      });
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function runDoctor(stackPath?: string, mode?: string): Promise<number> {
  console.log(`\n  ${bold(magenta('om'))} ${dim('—')} ${bold('doctor diagnósticos de entorno')}`);
  console.log(`  ${dim('────────────────────────────────────────')}`);

  let hasErrors = false;
  let hasWarnings = false;

  // 1. Cargar stack.yaml
  let loaded: LoadedStack | undefined;
  try {
    loaded = loadStack(stackPath, mode);
    const modeLabel = loaded.activeMode ? ` (mode: ${bold(yellow(loaded.activeMode))})` : '';
    const overrideLabel = loaded.overridePath ? ` ${dim('(con override local)')}` : '';
    console.log(`  ${green('✓')} ${bold('Stack:')}        ${loaded.stack.name}${modeLabel}${overrideLabel}`);
    console.log(`  ${green('✓')} ${bold('Directorio:')}   ${loaded.workspaceRoot}`);
  } catch (err) {
    hasErrors = true;
    console.log(`  ${red('✗')} ${bold('Stack:')}        No se pudo cargar o parsear`);
    console.log(`    ${red(err instanceof Error ? err.message : String(err))}`);
  }

  // 2. Verificar Docker Daemon
  const dockerInfoRes = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (dockerInfoRes.status === 0) {
    console.log(`  ${green('✓')} ${bold('Docker:')}        Corriendo y accesible`);
  } else {
    hasErrors = true;
    console.log(`  ${red('✗')} ${bold('Docker:')}        No accesible. ¿Está Docker Desktop iniciado?`);
  }

  // 3. Si el stack cargó, verificar puertos y repositorios
  if (loaded) {
    const stack = loaded.stack;

    // Verificar colisión de puertos en el host
    const portsToCheck: { port: number; owner: string }[] = [];
    if (stack.gateway) {
      portsToCheck.push({ port: stack.gateway.port, owner: `Gateway (puerto ${stack.gateway.port})` });
    }
    for (const [name, svc] of Object.entries(stack.services)) {
      if (svc.expose_host !== undefined) {
        portsToCheck.push({ port: svc.expose_host, owner: `Service "${name}" (expose_host=${svc.expose_host})` });
      }
      if (svc.debug_port !== undefined) {
        portsToCheck.push({ port: svc.debug_port, owner: `Service "${name}" (debug_port=${svc.debug_port})` });
      }
    }

    if (portsToCheck.length > 0) {
      console.log(`  ${bold('Puertos host:')}`);
      for (const item of portsToCheck) {
        const available = await isPortAvailable(item.port);
        if (available) {
          console.log(`    ${green('✓')} Puerto ${bold(item.port.toString())} está disponible para ${dim(item.owner)}`);
        } else {
          hasErrors = true;
          console.log(`    ${red('✗')} Puerto ${bold(red(item.port.toString()))} en uso - Colisión en ${bold(item.owner)}`);
        }
      }
    }

    // Verificar repositorios
    const reposDir = resolve(loaded.workspaceRoot, 'repos');
    const servicesWithRepos = Object.entries(stack.services).filter(([_, svc]) => hasRepo(svc));

    if (servicesWithRepos.length > 0) {
      console.log(`  ${bold('Repositorios Git:')}`);
      for (const [name, svc] of servicesWithRepos) {
        if (hasRepo(svc)) {
          const slug = repoSlug(svc.repo);
          const targetDir = join(reposDir, slug);
          const exists = existsSync(join(targetDir, '.git'));
          if (exists) {
            console.log(`    ${green('✓')} ${bold(name.padEnd(15))} Clonado en repos/${slug}`);
          } else {
            hasWarnings = true;
            console.log(`    ${yellow('⚠')} ${bold(name.padEnd(15))} Falta clonar (correr 'om sync' para repos/${slug})`);
          }
        }
      }
    }
  }

  // 4. Verificar configuraciones del entorno del host (~/.npmrc)
  const npmrcPath = join(homedir(), '.npmrc');
  if (existsSync(npmrcPath)) {
    const content = readFileSync(npmrcPath, 'utf8');
    const hasLogieincReg = content.includes('npm.pkg.github.com');
    const hasAuthToken = content.includes('_authToken');
    if (hasLogieincReg && hasAuthToken) {
      console.log(`  ${green('✓')} ${bold('.npmrc:')}        Configurado con token de GitHub Packages`);
    } else {
      hasWarnings = true;
      console.log(`  ${yellow('⚠')} ${bold('.npmrc:')}        Existe pero falta configuración de GitHub Packages (@logieinc)`);
    }
  } else {
    hasWarnings = true;
    console.log(`  ${yellow('⚠')} ${bold('.npmrc:')}        No se encontró en ~/.npmrc`);
  }

  console.log(`  ${dim('────────────────────────────────────────')}`);
  if (hasErrors) {
    console.log(`  ${bold(red('DIAGNÓSTICO: FALLIDO'))} — Revisa los errores marcados con ${red('✗')}\n`);
    return 1;
  } else if (hasWarnings) {
    console.log(`  ${bold(yellow('DIAGNÓSTICO: ADVERTENCIA'))} — Revisa las alertas marcadas con ${yellow('⚠')}\n`);
    return 0;
  } else {
    console.log(`  ${bold(green('DIAGNÓSTICO: COMPLETO (SANO)'))} — Todo configurado correctamente\n`);
    return 0;
  }
}
