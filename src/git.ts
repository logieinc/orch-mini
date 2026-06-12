import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RepoGitStatus {
  branch: string;
  author: string;
  date: string;
  subject: string;
}

export function getRepoGitStatus(repoPath: string): RepoGitStatus | null {
  const gitDir = join(repoPath, '.git');
  if (!existsSync(gitDir)) {
    return null;
  }

  try {
    // 1. Obtener rama activa
    const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
    });
    let branch = branchRes.stdout.trim();
    if (branch === 'HEAD') {
      const commitRes = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8',
      });
      branch = `(detached at ${commitRes.stdout.trim()})`;
    }

    // 2. Obtener info del último commit (Autor | Fecha Relativa | Mensaje)
    const logRes = spawnSync('git', ['log', '-1', '--format=%an|%cr|%s'], {
      cwd: repoPath,
      encoding: 'utf8',
    });

    if (logRes.status === 0 && logRes.stdout) {
      const [author, date, subject] = logRes.stdout.trim().split('|');
      return {
        branch: branch || 'unknown',
        author: author || 'unknown',
        date: date || 'unknown',
        subject: subject || 'no commit message',
      };
    }
  } catch {
    // Fallback silencioso si no es un repo válido
  }

  return null;
}

export function listRepoBranches(repoPath: string): string[] {
  try {
    const res = spawnSync('git', ['branch', '-a', '--format=%(refname:short)'], {
      cwd: repoPath,
      encoding: 'utf8',
    });

    if (res.status === 0 && res.stdout) {
      const branches = res.stdout
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b.length > 0 && !b.includes('origin/HEAD'));

      // Limpiar prefijo origin/ y deduplicar
      const cleaned = branches.map((b) => (b.startsWith('origin/') ? b.slice('origin/'.length) : b));
      return [...new Set(cleaned)].sort();
    }
  } catch {
    // Fallback
  }
  return [];
}

export function checkoutRepoBranch(repoPath: string, branchName: string): { success: boolean; error?: string } {
  try {
    const res = spawnSync('git', ['checkout', branchName], {
      cwd: repoPath,
      encoding: 'utf8',
    });

    if (res.status === 0) {
      return { success: true };
    }
    return { success: false, error: res.stderr.trim() || `exit code ${res.status}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
