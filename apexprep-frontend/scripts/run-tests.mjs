/**
 * Runs the frontend's `src/**\/*.test.ts(x)` files without a test-runner dependency.
 *
 * Each file is bundled with the esbuild that ships with Vite (the `@/` alias comes from tsconfig `paths`, which
 * esbuild reads), written to the OS temp directory, and imported under Node. The harness in `src/tests/harness.ts`
 * reports each case and records failures on `globalThis`; this script turns them into an exit code.
 */
import { build } from 'esbuild'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'src')

function findTests(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return findTests(full)
    return /\.test\.tsx?$/.test(name) ? [full] : []
  })
}

const out = mkdtempSync(join(tmpdir(), 'apexprep-fe-tests-'))
try {
  for (const file of findTests(src)) {
    console.log(relative(root, file))
    const outfile = join(out, `${relative(src, file).replace(/[\\/]/g, '_')}.mjs`)
    await build({
      entryPoints: [file],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      jsx: 'automatic',
      tsconfig: join(root, 'tsconfig.json'),
      loader: { '.svg': 'dataurl', '.png': 'dataurl', '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"test"' },
      // Bundled CommonJS (react-dom/server) requires Node built-ins; an ES module needs a `require` for that.
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
      logLevel: 'error',
    })
    await import(pathToFileURL(outfile).href)
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}

const failures = globalThis.__testFailures ?? 0
const count = globalThis.__testCount ?? 0
console.log(`\n${count - failures} passed, ${failures} failed, ${count} total`)
process.exitCode = failures > 0 || count === 0 ? 1 : 0
