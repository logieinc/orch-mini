// Helpers de URL/slug de repos — usados por compose, scripts, sync y deben coincidir.

export function isLocalRepo(repo: string): boolean {
  return repo.startsWith('./') || repo.startsWith('../') || repo.startsWith('/');
}

export function normalizeGitUrl(repo: string): string {
  if (/^https?:\/\//.test(repo)) return repo;
  if (/^git@/.test(repo)) return repo;
  if (/^ssh:\/\//.test(repo)) return repo;

  if (/^[a-z0-9.-]+\/[^/]+\/[^/]+/.test(repo)) {
    const withGit = repo.endsWith('.git') ? repo : `${repo}.git`;
    return `https://${withGit}`;
  }
  return repo;
}

export function repoSlug(repo: string): string {
  if (isLocalRepo(repo)) {
    const parts = repo.replace(/\/$/, '').split('/');
    return parts[parts.length - 1] ?? repo;
  }
  const cleaned = repo.replace(/\.git$/, '').replace(/\/$/, '');
  const colonIdx = cleaned.indexOf(':');
  const tail =
    colonIdx >= 0 && !cleaned.startsWith('http') ? cleaned.slice(colonIdx + 1) : cleaned;
  const parts = tail.split('/');
  return parts[parts.length - 1] ?? tail;
}
