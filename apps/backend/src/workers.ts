// Spawn a TypeScript worker module. Worker threads do not reliably inherit tsx's loader, so each worker entry is
// bundled once per process with esbuild (all workspace TypeScript inlined) and the bundle is started instead.
import { Worker } from 'node:worker_threads';
import { availableParallelism, tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const outDir = mkdtempSync(join(tmpdir(), 'pitwall-workers-'));
const bundles = new Map<string, string>();

function bundle(file: URL): string {
  const src = fileURLToPath(file);
  let out = bundles.get(src);
  if (!out) {
    out = join(outDir, basename(src).replace(/\.ts$/, '.mjs'));
    buildSync({
      entryPoints: [src],
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      sourcemap: 'inline',
      logLevel: 'silent',
      // some bundled CommonJS dependencies call require(); give the ESM bundle one
      banner: { js: "import { createRequire as __pitwallCreateRequire } from 'node:module'; const require = __pitwallCreateRequire(import.meta.url);" },
    });
    bundles.set(src, out);
  }
  return out;
}

export function spawnWorker(file: URL, workerData: Record<string, unknown> = {}): Worker {
  return new Worker(bundle(file), { workerData, execArgv: [] });
}

export function cpuCount(): number {
  return Math.max(1, availableParallelism());
}
