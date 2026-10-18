/**
 * A stand-in for the two `node:url` members `vite.config.ts` imports.
 *
 * `tsconfig.json` includes `vite.config.ts` in the programme, but the project has no `@types/node` dependency, so
 * `import { fileURLToPath, URL } from 'node:url'` has no declarations and `npm run typecheck` — and therefore
 * `npm run build`, which runs `tsc --noEmit` first — failed before this file existed. That failure predates this
 * integration; it is fixed here rather than left in the way of the build.
 *
 * Declared locally instead of adding `@types/node`, because the app itself has no Node code: this is one build
 * script's import, and pulling Node's whole global type surface into a browser project would also make Node
 * globals appear available inside `src/`, where they are not.
 */
declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
  export const URL: typeof globalThis.URL
}
