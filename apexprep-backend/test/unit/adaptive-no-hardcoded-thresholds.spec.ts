import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Requirement: **no adaptive threshold is hard-coded in TypeScript.** Every tunable comes
 * from the active `engine_config` version.
 *
 * This scans the engine's behavioural files for the literal values the requirements state,
 * with comments and strings removed. `engine-params.ts` is excluded on purpose: it is the
 * schema, where range bounds (`.min()`, `.max()`) legitimately appear — it holds no
 * behavioural value and no default.
 */

const ENGINE_DIR = resolve(__dirname, '../../src/adaptive');
const BEHAVIOURAL_FILES = ['elo.ts', 'levels.ts', 'guess.ts', 'decay.ts', 'selection.ts', 'attempt-update.ts'];

/** Values the requirements fix; none of them may appear as a literal in engine logic. */
const FORBIDDEN_LITERALS = [
  400, // Elo scale
  32, // K_s, first attempts
  16, // K_s, steady
  24, // K_q, uncalibrated
  0.72, // target success
  1.25, // promotion speed factor
  0.25, // probable-guess time fraction
  21, // inactivity grace, days
  30, // exclusion window, days
  50, // K_q calibration threshold
  20, // K_s attempt threshold
];

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
}

describe('the engine holds no adaptive thresholds of its own', () => {
  it('covers every behavioural file in src/adaptive', () => {
    const present = readdirSync(ENGINE_DIR).filter((f) => f.endsWith('.ts'));
    expect([...present].sort()).toEqual([...BEHAVIOURAL_FILES, 'engine-params.ts', 'time.ts', 'index.ts'].sort());
  });

  it.each(BEHAVIOURAL_FILES)('%s contains no stated threshold as a literal', (file) => {
    const code = stripCommentsAndStrings(readFileSync(resolve(ENGINE_DIR, file), 'utf8'));
    const numbers = (code.match(/(?<![\w.])\d+(?:\.\d+)?/g) ?? []).map(Number);
    const found = FORBIDDEN_LITERALS.filter((v) => numbers.includes(v));
    expect(found).toEqual([]);
  });

  it.each(BEHAVIOURAL_FILES)('%s reads its values from the params argument', (file) => {
    const code = readFileSync(resolve(ENGINE_DIR, file), 'utf8');
    expect(code).toMatch(/params\./);
  });
});
