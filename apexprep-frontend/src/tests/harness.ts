/**
 * A minimal test harness for the frontend's route tests.
 *
 * The project has no test runner dependency, and these tests need none: `scripts/run-tests.mjs` bundles each
 * `*.test.ts(x)` file with the esbuild that ships inside Vite and runs it under Node. Deliberately free of Node
 * imports, so `src/` stays a browser-only TypeScript programme.
 */
type Case = { name: string; fn: () => void | Promise<void> }
const cases: Case[] = []

export function test(name: string, fn: () => void | Promise<void>): void {
  cases.push({ name, fn })
}

export function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

/** Runs every registered case and records failures where the runner can read them. */
export async function runTests(suite: string): Promise<void> {
  const g = globalThis as unknown as { __testFailures?: number; __testCount?: number }
  for (const c of cases) {
    try {
      await c.fn()
      console.log(`  ✓ ${suite} › ${c.name}`)
    } catch (error) {
      g.__testFailures = (g.__testFailures ?? 0) + 1
      console.log(`  ✗ ${suite} › ${c.name}\n      ${error instanceof Error ? error.message : String(error)}`)
    }
    g.__testCount = (g.__testCount ?? 0) + 1
  }
  cases.length = 0
}
