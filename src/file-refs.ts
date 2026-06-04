import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// Patrón ${file:<path>} — todo el string. No se soporta interpolación parcial
// (un PEM no se va a embeber en medio de otra cosa).
const FILE_REF = /^\$\{file:([^}]+)\}$/;

// Reemplaza valores ${file:path} por el contenido del archivo (paths
// relativos al workDir del stack). Recorre objetos y arrays recursivamente.
export function expandFileRefs(value: unknown, workDir: string): unknown {
  if (typeof value === 'string') {
    const m = FILE_REF.exec(value);
    if (!m) return value;
    const rel = m[1]!.trim();
    const abs = isAbsolute(rel) ? rel : resolve(workDir, rel);
    try {
      return readFileSync(abs, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`\${file:${rel}}: no se pudo leer ${abs} — ${msg}`);
    }
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandFileRefs(v, workDir));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandFileRefs(v, workDir);
    }
    return out;
  }
  return value;
}
