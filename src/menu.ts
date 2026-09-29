import readline from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadStack, type LoadedStack } from './parser.js';
import { renderMermaid } from './renderer/graph.js';
import { hasRepo } from './schema.js';
import { repoSlug } from './repo.js';
import { getRepoGitStatus, listRepoBranches, checkoutRepoBranch } from './git.js';

export interface MenuContext {
  runDockerCompose: (args: string[], mode?: string) => number;
  runTask: (name: string, args: string[], mode?: string) => number;
  runInfo: (mode?: string) => number;
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

    // Cada opción lleva su `key`: el dispatch de abajo va por clave, no por
    // índice. Agregar una opción en el medio no renumera nada.
    const declaredTasks = stack.tasks ?? {};
    const taskCount = Object.keys(declaredTasks).length;
    const menuOptions: Array<{ key: string; label: string }> = [
      { key: 'up',        label: "▶   om up         (Levantar todo o servicios)" },
      { key: 'down',      label: "⏹   om down       (Detener/remover todo o servicios)" },
      { key: 'stop',      label: "⏸   om stop       (Parar sin remover los containers)" },
      { key: 'restart',   label: "🔄  om restart    (Reiniciar todo o servicios)" },
      { key: 'recreate',  label: "🚀  om recreate   (Forzar recreación/recargar env)" },
      { key: 'build',     label: "🛠   om build      (Construir imágenes)" },
      { key: 'logs',      label: "📋  om logs       (Ver logs de servicios)" },
      { key: 'shell',     label: "🐚  om shell      (Entrar a la consola de un servicio)" },
    ];

    // Accesos directos a los documentos del stack, cuando el stack.yaml declara
    // esas tasks. Siguen estando en el submenú `tasks` — esto es un atajo, no
    // un lugar distinto.
    if (declaredTasks['deuda']) {
      menuOptions.push({ key: 'task:deuda', label: "📕  om deuda      (Lo que el stack arrastra hoy)" });
    }
    if (declaredTasks['decisiones']) {
      menuOptions.push({ key: 'task:decisiones', label: "📘  om decisiones (El criterio ya tomado, y por qué)" });
    }

    menuOptions.push(
      { key: 'tasks',     label: `🧩  tasks         (las ${taskCount} declaradas en el stack.yaml)` },
      { key: 'prune',     label: "🧹  om prune      (Limpieza total: borrar volumes y datos)" },
      { key: 'info',      label: "📄  om info       (Resumen: documentos, tasks, services, env)" },
      { key: 'graph',     label: "📊  om graph      (Generar diagrama Mermaid del stack)" },
      { key: 'branches',  label: "🌿  om branches   (Ver ramas activas / cambiar rama)" },
      { key: 'sync',      label: "📥  om sync       (Sincronizar repositorios Git)" },
      { key: 'gen',       label: "⚙️   om gen        (Regenerar compose/nginx/scripts)" },
      { key: 'validate',  label: "🔍  om validate   (Validar stack.yaml)" },
      { key: 'vscode',    label: "💻  om vscode     (Generar config VS Code)" },
      { key: 'doctor',    label: "🩺  om doctor     (Diagnóstico del entorno)" },
    );

    const hasModes = loaded.declaredModes && loaded.declaredModes.length > 1;
    if (hasModes) {
      menuOptions.push({ key: 'mode', label: `⚙️   Cambiar mode (actual: ${loaded.activeMode})` });
    }
    menuOptions.push({ key: 'exit', label: "🚪  Salir" });

    const mainChoice = await selectOption("Selecciona una acción:", menuOptions.map((o) => o.label));
    const key = menuOptions[mainChoice]?.key ?? 'exit';

    if (key === 'exit') {
      console.clear();
      break;
    }

    if (key === 'mode') {
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

    if (key === 'up') { // om up
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

    } else if (key === 'down') { // om down
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

    } else if (key === 'stop') { // om stop
      const serviceOptions = getDecoratedServices();
      const svcChoice = await selectOption("Parar sin remover (om stop):", [
        "[Todo el stack]",
        ...serviceOptions,
        "[Volver al menú principal]"
      ]);
      if (svcChoice === serviceNames.length + 1) continue;

      console.clear();
      if (svcChoice === 0) {
        await runAction(() => context.runDockerCompose(['stop'], activeModeStr));
      } else {
        await runAction(() => context.runDockerCompose(['stop', serviceNames[svcChoice - 1]!], activeModeStr));
      }
      await pressAnyKeyToContinue();

    } else if (key.startsWith('task:')) { // atajo directo a una task
      console.clear();
      await runAction(() => context.runTask(key.slice('task:'.length), [], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (key === 'tasks') { // tasks declaradas en el stack.yaml
      const taskEntries = Object.entries(stack.tasks ?? {});
      if (taskEntries.length === 0) {
        console.clear();
        console.log(`\n  \x1b[2mEl stack '${stack.name}' no declara \x1b[0mtasks:\x1b[2m en su stack.yaml.\x1b[0m\n`);
        await pressAnyKeyToContinue();
        continue;
      }
      // La descripción va al lado del nombre, recortada al ancho de la
      // terminal — las de metro/gli19 son largas y romperían el render.
      const nameWidth = Math.max(...taskEntries.map(([n]) => n.length));
      // `columns` puede venir 0 (sin tty real), no solo undefined.
      const room = Math.max(20, (process.stdout.columns || 100) - nameWidth - 12);
      const taskOptions = taskEntries.map(([name, t]) => {
        const desc = t.description.length > room ? t.description.slice(0, room - 1) + '…' : t.description;
        return `${name.padEnd(nameWidth)}  \x1b[2m${desc}\x1b[0m`;
      });
      const taskChoice = await selectOption("tasks del stack:", [
        ...taskOptions,
        "[Volver al menú principal]"
      ]);
      if (taskChoice >= taskEntries.length) continue;

      console.clear();
      const taskName = taskEntries[taskChoice]![0];
      await runAction(() => context.runTask(taskName, [], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (key === 'info') { // om info
      console.clear();
      await runAction(() => context.runInfo(activeModeStr));
      await pressAnyKeyToContinue();

    } else if (key === 'restart') { // om restart
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

    } else if (key === 'recreate') { // om recreate
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

    } else if (key === 'build') { // om build
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

    } else if (key === 'logs') { // om logs
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

    } else if (key === 'shell') { // om shell
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

    } else if (key === 'prune') { // om prune
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

    } else if (key === 'graph') { // om graph
      console.clear();
      console.log(`\n  \x1b[1m\x1b[35mom\x1b[0m \x1b[1m— Diagrama de Arquitectura (Mermaid)\x1b[0m`);
      console.log(`  \x1b[2m════════════════════════════════════════\x1b[0m`);
      const mermaidStr = renderMermaid(stack);
      console.log(mermaidStr);
      console.log(`  \x1b[2m────────────────────────────────────────\x1b[0m`);
      console.log(`  \x1b[32m💡 Copia el texto anterior y pégalo en un visor de Mermaid o en tu archivo Markdown.\x1b[0m`);
      await pressAnyKeyToContinue();

    } else if (key === 'branches') { // om branches
      console.clear();
      console.log(`\n  \x1b[1m\x1b[35mom\x1b[0m \x1b[1m— Estado de Ramas Git\x1b[0m`);
      console.log(`  \x1b[2m════════════════════════════════════════════════════════════════════════════════\x1b[0m`);

      const reposDir = join(loaded.workspaceRoot, 'repos');
      const serviceNamesWithRepo = serviceNames.filter((name) => hasRepo(stack.services[name]!));

      let hasCloned = false;
      const formattedLines: string[] = [];
      const clonedServices: string[] = [];

      for (const name of serviceNamesWithRepo) {
        const svc = stack.services[name]!;
        if (!hasRepo(svc)) continue;
        const slug = repoSlug(svc.repo);
        const targetDir = join(reposDir, slug);
        const status = getRepoGitStatus(targetDir);

        if (status) {
          hasCloned = true;
          clonedServices.push(name);
          const authorStr = status.author.slice(0, 15);
          const commitInfo = `[${authorStr}, ${status.date}]`;
          const subjectStr = status.subject.slice(0, 35);
          formattedLines.push(
            `  \x1b[32m✓\x1b[0m \x1b[1m${name.padEnd(25)}\x1b[0m \x1b[36m${status.branch.padEnd(25)}\x1b[0m \x1b[2m${commitInfo.padEnd(30)} ${subjectStr}\x1b[0m`
          );
        } else {
          formattedLines.push(`  \x1b[33m⚠\x1b[0m ${name.padEnd(25)} \x1b[2m(no clonado)\x1b[0m`);
        }
      }

      for (const line of formattedLines) {
        console.log(line);
      }
      console.log(`  \x1b[2m════════════════════════════════════════════════════════════════════════════════\x1b[0m`);

      if (!hasCloned) {
        console.log('  No hay repositorios clonados. Primero corre om sync.');
        await pressAnyKeyToContinue();
        continue;
      }

      const actionChoice = await selectOption("¿Qué deseas hacer?", [
        "[Cambiar rama de algún repositorio]",
        "[Volver al menú principal]"
      ]);

      if (actionChoice !== 0) continue;

      const svcChoice = await selectOption("Selecciona el servicio a modificar:", [
        ...clonedServices,
        "[Cancelar]"
      ]);
      if (svcChoice === clonedServices.length) continue;

      const selectedSvc = clonedServices[svcChoice]!;
      const svc = stack.services[selectedSvc]!;
      if (!hasRepo(svc)) continue;
      const selectedSlug = repoSlug(svc.repo);
      const selectedDir = join(reposDir, selectedSlug);

      const branches = listRepoBranches(selectedDir);
      if (branches.length === 0) {
        console.log('\n  No se pudieron obtener ramas de este repositorio.');
        await pressAnyKeyToContinue();
        continue;
      }

      const currentBranch = getRepoGitStatus(selectedDir)?.branch;
      const branchOptions = branches.map((b) => b === currentBranch ? `* \x1b[32m${b} (actual)\x1b[0m` : `  ${b}`);

      const branchChoice = await selectOption(`Selecciona la rama para repos/${selectedSlug}:`, [
        ...branchOptions,
        "[Cancelar]"
      ]);
      if (branchChoice === branches.length) continue;

      const targetBranch = branches[branchChoice]!;
      console.clear();
      console.log(`\x1b[33mCambiando repos/${selectedSlug} a la rama "${targetBranch}"...\x1b[0m\n`);

      const res = checkoutRepoBranch(selectedDir, targetBranch);
      if (res.success) {
        console.log(`\x1b[32m✓ Rama cambiada con éxito.\x1b[0m`);
      } else {
        console.error(`\x1b[31m✗ Error al cambiar de rama: ${res.error}\x1b[0m`);
      }
      await pressAnyKeyToContinue();

    } else if (key === 'sync') { // om sync
      console.clear();
      await runAction(() => context.runSync(activeModeStr));
      await pressAnyKeyToContinue();

    } else if (key === 'gen') { // om gen
      console.clear();
      await runAction(() => context.runGen([], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (key === 'validate') { // om validate
      console.clear();
      await runAction(() => context.runValidate([], activeModeStr));
      await pressAnyKeyToContinue();

    } else if (key === 'vscode') { // om vscode
      console.clear();
      await runAction(() => context.runVscode(activeModeStr));
      await pressAnyKeyToContinue();

    } else if (key === 'doctor') { // om doctor
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
