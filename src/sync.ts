import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isLocalRepo, normalizeGitUrl, repoSlug } from './repo.js';
import { hasRepo, type Stack } from './schema.js';

export type SyncResult = {
  service: string;
  repo: string;
  action:
    | 'cloned'
    | 'pulled'
    | 'switched'
    | 'local-ok'
    | 'local-missing'
    | 'failed'
    | 'skipped-no-repo'
    | 'skipped-dup';
  message?: string;
};

export function syncStack(
  stack: Stack,
  opts: { workDir: string; reposDir: string },
): SyncResult[] {
  const results: SyncResult[] = [];
  const seenSlugs = new Set<string>();

  for (const [name, svc] of Object.entries(stack.services)) {
    if (!hasRepo(svc)) {
      results.push({ service: name, repo: '(no repo)', action: 'skipped-no-repo' });
      continue;
    }
    const slug = repoSlug(svc.repo);
    if (seenSlugs.has(slug)) {
      results.push({
        service: name,
        repo: svc.repo,
        action: 'skipped-dup',
        message: `mismo repo que un service anterior (slug=${slug})`,
      });
      continue;
    }
    seenSlugs.add(slug);
    results.push(syncOne(name, svc.repo, svc.ref, opts));
  }

  return results;
}

function syncOne(
  service: string,
  repo: string,
  ref: string | undefined,
  opts: { workDir: string; reposDir: string },
): SyncResult {
  if (isLocalRepo(repo)) {
    const abs = isAbsolute(repo) ? repo : resolve(opts.workDir, repo);
    if (existsSync(abs)) {
      return { service, repo, action: 'local-ok', message: abs };
    }
    return { service, repo, action: 'local-missing', message: `no existe: ${abs}` };
  }

  const url = normalizeGitUrl(repo);
  const slug = repoSlug(repo);
  const targetDir = join(opts.reposDir, slug);

  if (existsSync(join(targetDir, '.git'))) {
    // Repo ya clonado. Si declara ref distinto al actual, switchear; sino pull --ff-only.
    if (ref !== undefined) {
      const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], targetDir);
      const currentBranch = current.stdout.trim();
      if (currentBranch !== ref) {
        const fetchRes = git(['fetch', 'origin', ref], targetDir);
        if (fetchRes.status !== 0) {
          return {
            service,
            repo,
            action: 'failed',
            message: `git fetch origin ${ref} falló: ${fetchRes.stderr}`,
          };
        }
        const checkoutRes = git(['checkout', ref], targetDir);
        if (checkoutRes.status !== 0) {
          return {
            service,
            repo,
            action: 'failed',
            message: `git checkout ${ref} falló: ${checkoutRes.stderr}`,
          };
        }
        return { service, repo, action: 'switched', message: `${targetDir} → ${ref}` };
      }
    }
    const pullRes = git(['pull', '--ff-only'], targetDir);
    if (pullRes.status !== 0) {
      return { service, repo, action: 'failed', message: `git pull falló: ${pullRes.stderr}` };
    }
    return { service, repo, action: 'pulled', message: targetDir };
  }

  if (existsSync(targetDir) && !existsSync(join(targetDir, '.git'))) {
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch {
      return {
        service,
        repo,
        action: 'failed',
        message: `la carpeta repos/${slug} ya existe y no se pudo limpiar. Detén el stack con 'om down' e intenta de nuevo.`,
      };
    }
  }

  const cloneArgs = ['clone'];
  if (ref !== undefined) cloneArgs.push('--branch', ref);
  cloneArgs.push(url, targetDir);
  const cloneRes = git(cloneArgs, opts.reposDir);
  if (cloneRes.status !== 0) {
    return { service, repo, action: 'failed', message: `git clone falló: ${cloneRes.stderr}` };
  }
  return {
    service,
    repo,
    action: 'cloned',
    message: ref !== undefined ? `${targetDir} (ref=${ref})` : targetDir,
  };
}

function git(args: string[], cwd: string): { status: number; stderr: string; stdout: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: res.status ?? 1,
    stderr: (res.stderr ?? '').trim(),
    stdout: res.stdout ?? '',
  };
}
