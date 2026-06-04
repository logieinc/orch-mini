import { repoSlug } from '../repo.js';
import { hasRepo, type Stack } from '../schema.js';

export type ScriptFile = {
  path: string;
  content: string;
  executable: boolean;
};

// Para acciones sobre el stack (up/down/logs/ps) usar el CLI `om` directamente.
// Acá solo generamos el caso único que el CLI no cubre: correr un service nativo
// en el host con env apuntando al resto del compose. Se emite en bash (.sh) y
// PowerShell (.ps1) para soporte cross-platform.
// Solo aplica a services con repo: (los que tienen código local que se puede correr nativo).
export function renderScripts(stack: Stack): ScriptFile[] {
  const files: ScriptFile[] = [];

  for (const [name, svc] of Object.entries(stack.services)) {
    if (!hasRepo(svc)) continue;
    files.push({
      path: `scripts/${name}.sh`,
      content: svcStandaloneBash(stack, name),
      executable: true,
    });
    files.push({
      path: `scripts/${name}.ps1`,
      content: svcStandalonePwsh(stack, name),
      executable: false,
    });
  }

  return files;
}

function svcStandaloneBash(stack: Stack, svcName: string): string {
  const svc = stack.services[svcName]!;
  if (!hasRepo(svc)) return '';

  const envLines: string[] = [`export PORT="${svc.port}"`];
  for (const [k, v] of Object.entries(svc.env ?? {})) {
    envLines.push(`export ${k}="${escapeForBash(rewriteForHost(v, stack))}"`);
  }

  const slug = repoSlug(svc.repo);

  return `#!/usr/bin/env bash
# Generado por om — no editar a mano.
# Corre ${svcName} nativo en el host (sin docker), conectado al resto del stack.
# Útil para debugging con IDE/debugger nativo.
set -euo pipefail
cd "$(dirname "$0")/.."

REPOS_DIR="\${REPOS_DIR:-$(pwd)/../repos}"
SERVICE_DIR="$REPOS_DIR/${slug}"

if [ ! -d "$SERVICE_DIR" ]; then
  echo "no se encuentra el repo en $SERVICE_DIR — clonalo primero" >&2
  exit 1
fi

${envLines.join('\n')}

cd "$SERVICE_DIR"

if [ -n "\${OM_CMD:-}" ]; then
  exec $OM_CMD
elif [ -f package.json ] && command -v npm >/dev/null 2>&1; then
  exec npm run dev
fi

echo "no se detectó comando de arranque — setea OM_CMD" >&2
exit 1
`;
}

function svcStandalonePwsh(stack: Stack, svcName: string): string {
  const svc = stack.services[svcName]!;
  if (!hasRepo(svc)) return '';

  const envLines: string[] = [`$env:PORT = "${svc.port}"`];
  for (const [k, v] of Object.entries(svc.env ?? {})) {
    envLines.push(`$env:${k} = "${escapeForPwsh(rewriteForHost(v, stack))}"`);
  }

  const slug = repoSlug(svc.repo);

  return `# Generado por om — no editar a mano.
# Corre ${svcName} nativo en el host (sin docker), conectado al resto del stack.
# Útil para debugging con IDE/debugger nativo.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$ReposDir = if ($env:REPOS_DIR) { $env:REPOS_DIR } else { Join-Path (Get-Location) '..\\repos' }
$ServiceDir = Join-Path $ReposDir '${slug}'

if (-not (Test-Path $ServiceDir)) {
    Write-Error "no se encuentra el repo en $ServiceDir — clonalo primero"
    exit 1
}

${envLines.join('\n')}

Set-Location $ServiceDir

if ($env:OM_CMD) {
    Invoke-Expression $env:OM_CMD
} elseif ((Test-Path 'package.json') -and (Get-Command npm -ErrorAction SilentlyContinue)) {
    & npm run dev
} else {
    Write-Error "no se detectó comando de arranque — setea OM_CMD"
    exit 1
}
`;
}

function rewriteForHost(value: string, stack: Stack): string {
  // En el compose "api" resuelve por DNS interno; corriendo nativo en el host
  // hay que ir a localhost:<expose_host>. Matchea tanto //host:port (URL plain)
  // como @host:port (URL con userinfo).
  return value.replace(
    /(\/\/|@)([a-z][a-z0-9_-]*):(\d+)/g,
    (match, prefix: string, target: string, _port: string) => {
      const targetSvc = stack.services[target];
      if (!targetSvc) return match;
      if (targetSvc.expose_host === undefined) return match;
      return `${prefix}localhost:${targetSvc.expose_host}`;
    },
  );
}

function escapeForBash(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
}

function escapeForPwsh(value: string): string {
  // En PowerShell double-quoted strings: " se escapa como `", $ como `$, ` como ``.
  return value.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');
}

