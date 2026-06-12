import readline from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadStack, type LoadedStack } from './parser.js';

export interface MenuContext {
  runDockerCompose: (args: string[], mode?: string) => number;
  runSync: (mode?: string) => number;
  runValidate: (args: string[], mode?: string) => number;
  runGen: (args: string[], mode?: string) => number;
  runVscode: (mode?: string) => number;
  runDoctor: (stackPath?: string, mode?: string) => Promise<number>;
}

/**
 * Muestra un menú de selección interactivo controlable con flechas de dirección (arriba/abajo o k/j) y Enter.
 */
export function selectOption(
  title: string,
  options: string[],
  initialIndex = 0
): Promise<number> {
  return new Promise((resolvePrompt) => {
    const stdout = process.stdout;
    const stdin = process.stdin;

    let selected = initialIndex;
    const count = options.length;

    readline.emitKeypressEvents(stdin);
    
    const isRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();

    // Ocultar cursor
    stdout.write('\x1b[?25l');

    const render = () => {
      stdout.write(`\n  \x1b[1m\x1b[35m❯\x1b[0m \x1b[1m${title}\x1b[0m\n`);
      for (let i = 0; i < count; i++) {
        if (i === selected) {
          stdout.write(`    \x1b[36m❯\x1b[0m \x1b[36m\x1b[1m${options[i]}\x1b[0m\n`);
        } else {
          stdout.write(`      \x1b[2m${options[i]}\x1b[0m\n`);
        }
      }
    };

    const cleanup = () => {
      // Mostrar cursor
      stdout.write('\x1b[?25h');
      if (stdin.isTTY) {
        stdin.setRawMode(isRaw);
      }
      stdin.pause();
    };

    const erase = () => {
      // Mover cursor arriba y limpiar líneas impresas
      // count + 2: 1 para el título y 1 para la línea vacía inicial.
      readline.moveCursor(stdout, 0, -(count + 2));
      for (let i = 0; i < count + 2; i++) {
        stdout.write('\x1b[2K\n');
      }
      readline.moveCursor(stdout, 0, -(count + 2));
    };

    render();

    const onKeypress = (str: string, key: any) => {
      if (key && key.ctrl && key.name === 'c') {
        cleanup();
        process.exit(0);
      }

      if (key && (key.name === 'up' || key.name === 'k')) {
        erase();
        selected = (selected - 1 + count) % count;
        render();
      } else if (key && (key.name === 'down' || key.name === 'j')) {
        erase();
        selected = (selected + 1) % count;
        render();
      } else if (key && (key.name === 'return' || key.name === 'enter')) {
        cleanup();
        stdin.off('keypress', onKeypress);
        resolvePrompt(selected);
      }
    };

    stdin.on('keypress', onKeypress);
  });
}

function pressAnyKeyToContinue(): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write('\n  \x1b[2mPresiona cualquier tecla para continuar...\x1b[0m\n');
    
    readline.emitKeypressEvents(stdin);
    const isRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    
    const onKey = () => {
      if (stdin.isTTY) {
        stdin.setRawMode(isRaw);
      }
      stdin.pause();
      stdin.off('keypress', onKey);
      resolve();
    };
    stdin.on('keypress', onKey);
  });
}

async function runAction(actionFn: () => Promise<number> | number | void): Promise<number> {
  const sigintHandler = () => {};
  process.on('SIGINT', sigintHandler);
  try {
    const status = await actionFn();
    return typeof status === 'number' ? status : 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    process.off('SIGINT', sigintHandler);
  }
}

export async function runMenu(context: MenuContext, mode?: string): Promise<number> {
  let loaded: LoadedStack;
  try {
    loaded = loadStack(undefined, mode);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let stack = loaded.stack;
  let serviceNames = Object.keys(stack.services);

  while (true) {
    console.clear();

    const activeModeStr = loaded.activeMode || undefined;
    const modeLabel = loaded.activeMode ? ` \x1b[33m[mode: ${loaded.activeMode}]\x1b[0m` : '';
    const overrideLabel = loaded.overridePath ? ' \x1b[2m(override)\x1b[0m' : '';
    console.log(`\n  \x1b[1m\x1b[35mom\x1b[0m \x1b[1m— Menú Interactivo\x1b[0m`);
    console.log(`  \x1b[2m════════════════════════════════════════\x1b[0m`);
    console.log(`  \x1b[1mStack:\x1b[0m  \x1b[36m${stack.name}\x1b[0m${modeLabel}${overrideLabel}`);
    console.log(`  \x1b[1mPath:\x1b[0m   \x1b[2m${loaded.workspaceRoot}\x1b[0m`);
    console.log(`  \x1b[2m────────────────────────────────────────\x1b[0m`);

    const menuOptions = [
      "▶   om up         (Levantar todo o servicios)",
      "⏹   om down       (Detener/remover todo o servicios)",
      "🔄  om restart    (Reiniciar todo o servicios)",
      "🚀  om recreate   (Forzar recreación/recargar env)",
      "🛠   om build      (Construir imágenes)",
      "📋  om logs       (Ver logs de servicios)",
      "🐚  om shell      (Entrar a la consola de un servicio)",
      "🧹  om prune      (Limpieza total: borrar volumes y datos)",
      "📥  om sync       (Sincronizar repositorios Git)",
      "⚙️   om gen        (Regenerar compose/nginx/scripts)",
      "🔍  om validate   (Validar stack.yaml)",
      "💻  om vscode     (Generar config VS Code)",
      "🩺  om doctor     (Diagnóstico del entorno)",
    ];

    const hasModes = loaded.declaredModes && loaded.declaredModes.length > 1;
    if (hasModes) {
      menuOptions.push(`⚙️   Cambiar mode (actual: ${loaded.activeMode})`);
    }
    menuOptions.push("🚪  Salir");

    const mainChoice = await selectOption("Selecciona una acción:", menuOptions);

    // Salir es siempre la última opción
    if (mainChoice === menuOptions.length - 1) {
      console.clear();
      break;
    }

    // Cambiar mode es la penúltima opción si hay modes
    if (hasModes && mainChoice === menuOptions.length - 2) {
      const modeChoice = await selectOption("Selecciona el mode:", [
        ...loaded.declaredModes!,
        "[Volver al menú principal]"
      ]);
      if (modeChoice < loaded.declaredModes!.length) {
        const newMode = loaded.declaredModes![modeChoice]!;
        try {
          loaded = loadStack(undefined, newMode);
          stack = loaded.stack;
          serviceNames = Object.keys(stack.services);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          await pressAnyKeyToContinue();
        }
      }
      continue;
    }

    // Para todas las acciones que listan servicios, consultamos los estados actuales
    const getDecoratedServices = () => {
      const statuses = getServiceStatuses(loaded);
      return serviceNames.map((name) => {
        const state = statuses.get(name);
        const statusLabel = getStatusLabel(state);
        return `${name.padEnd(20)} ${statusLabel}`;
      });
    };

    if (mainChoice === 0) { // om up
      const serviceOptions = getDecoratedServices();
      const svcChoice = await selectOption("Levantar (om up):", [
        "[Todo el stack]",
        ...serviceOptions,
        "[Volver al menú principal]"
      ]);
      if (svcChoice === serviceNames.length + 1) continue;

      console.clear();
      const args = svcChoice === 0 ? [] : [serviceNames[svcChoice - 1]!];
      await runAction(() => context.runDockerCompose(['up', '-d', ...args], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (mainChoice === 1) { // om down
      const serviceOptions = getDecoratedServices();
      const svcChoice = await selectOption("Detener/remover (om down):", [
        "[Todo el stack]",
        ...serviceOptions,
        "[Volver al menú principal]"
      ]);
      if (svcChoice === serviceNames.length + 1) continue;

      console.clear();
      if (svcChoice === 0) {
        await runAction(() => context.runDockerCompose(['down'], activeModeStr));
      } else {
        await runAction(() => context.runDockerCompose(['rm', '-fs', serviceNames[svcChoice - 1]!], activeModeStr));
      }
      await pressAnyKeyToContinue();

    } else if (mainChoice === 2) { // om restart
      const serviceOptions = getDecoratedServices();
      const svcChoice = await selectOption("Reiniciar (om restart):", [
        "[Todo el stack]",
        ...serviceOptions,
        "[Volver al menú principal]"
      ]);
      if (svcChoice === serviceNames.length + 1) continue;

      console.clear();
      const args = svcChoice === 0 ? [] : [serviceNames[svcChoice - 1]!];
      await runAction(() => context.runDockerCompose(['restart', ...args], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (mainChoice === 3) { // om recreate
      const serviceOptions = getDecoratedServices();
      const svcChoice = await selectOption("Forzar recreación (om recreate):", [
        "[Todo el stack]",
        ...serviceOptions,
        "[Volver al menú principal]"
      ]);
      if (svcChoice === serviceNames.length + 1) continue;

      console.clear();
      const args = svcChoice === 0 ? [] : [serviceNames[svcChoice - 1]!];
      await runAction(() => context.runDockerCompose(['up', '-d', '--force-recreate', ...args], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (mainChoice === 4) { // om build
      const serviceOptions = getDecoratedServices();
      const svcChoice = await selectOption("Construir imágenes (om build):", [
        "[Todo el stack]",
        ...serviceOptions,
        "[Volver al menú principal]"
      ]);
      if (svcChoice === serviceNames.length + 1) continue;

      console.clear();
      const args = svcChoice === 0 ? [] : [serviceNames[svcChoice - 1]!];
      await runAction(() => context.runDockerCompose(['build', ...args], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (mainChoice === 5) { // om logs
      const serviceOptions = getDecoratedServices();
      const svcChoice = await selectOption("Ver logs (om logs):", [
        "[Todo el stack]",
        ...serviceOptions,
        "[Volver al menú principal]"
      ]);
      if (svcChoice === serviceNames.length + 1) continue;

      console.clear();
      console.log(`\x1b[2mMostrando logs de docker-compose... Presiona Ctrl+C para detener y volver al menú.\x1b[0m\n`);
      const args = svcChoice === 0 ? [] : [serviceNames[svcChoice - 1]!];
      await runAction(() => context.runDockerCompose(['logs', '-f', '--tail=200', ...args], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (mainChoice === 6) { // om shell
      if (serviceNames.length === 0) {
        console.error('El stack no tiene servicios definidos.');
        await pressAnyKeyToContinue();
        continue;
      }
      const serviceOptions = getDecoratedServices();
      const svcChoice = await selectOption("Selecciona un servicio para entrar a su shell:", [
        ...serviceOptions,
        "[Volver al menú principal]"
      ]);
      if (svcChoice === serviceNames.length) continue;

      console.clear();
      console.log(`\x1b[2mAbriendo shell en ${serviceNames[svcChoice]!}... Presiona Ctrl+D o escribe 'exit' para salir.\x1b[0m\n`);
      await runAction(() => context.runDockerCompose(['exec', serviceNames[svcChoice]!, 'sh'], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (mainChoice === 7) { // om prune
      const confirmChoice = await selectOption(
        "¡ADVERTENCIA! Se borrarán todos los datos y bases de datos locales. ¿Continuar?",
        [
          "No, cancelar",
          "Sí, eliminar todos los datos de este stack"
        ],
        0
      );
      if (confirmChoice !== 1) continue;

      console.clear();
      console.log(`\x1b[33mLimpiando recursos del stack...\x1b[0m\n`);
      await runAction(() => context.runDockerCompose(['down', '-v', '--remove-orphans'], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (mainChoice === 8) { // om sync
      console.clear();
      await runAction(() => context.runSync(activeModeStr));
      await pressAnyKeyToContinue();

    } else if (mainChoice === 9) { // om gen
      console.clear();
      await runAction(() => context.runGen([], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (mainChoice === 10) { // om validate
      console.clear();
      await runAction(() => context.runValidate([], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (mainChoice === 11) { // om vscode
      console.clear();
      await runAction(() => context.runVscode(activeModeStr));
      await pressAnyKeyToContinue();

    } else if (mainChoice === 12) { // om doctor
      console.clear();
      await runAction(() => context.runDoctor(undefined, activeModeStr));
      await pressAnyKeyToContinue();
    }
  }

  return 0;
}

function getServiceStatuses(loaded: LoadedStack): Map<string, string> {
  const statuses = new Map<string, string>();
  const composePath = join(loaded.outDir, 'docker-compose.yaml');
  const envPath = join(loaded.outDir, '.env');

  if (!existsSync(composePath)) {
    return statuses;
  }

  try {
    const res = spawnSync(
      'docker',
      ['compose', '--env-file', envPath, '-f', composePath, 'ps', '-a', '--format', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );

    if (res.status === 0 && res.stdout) {
      const raw = res.stdout.trim();
      if (!raw) return statuses;

      let items: any[] = [];
      if (raw.startsWith('[')) {
        items = JSON.parse(raw);
      } else {
        items = raw.split('\n').map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(Boolean);
      }

      for (const item of items) {
        const serviceName = item.Service || item.service;
        const state = item.State || item.state || 'unknown';
        if (serviceName) {
          statuses.set(serviceName, state.toLowerCase());
        }
      }
    }
  } catch {
    // Graceful fallback
  }

  return statuses;
}

function getStatusLabel(state: string | undefined): string {
  if (!state) return '\x1b[2m[offline]\x1b[0m';
  switch (state) {
    case 'running':
      return '\x1b[32m[running]\x1b[0m';
    case 'exited':
      return '\x1b[31m[stopped]\x1b[0m';
    case 'paused':
      return '\x1b[33m[paused]\x1b[0m';
    case 'restarting':
      return '\x1b[35m[restarting]\x1b[0m';
    default:
      return `\x1b[36m[${state}]\x1b[0m`;
  }
}
