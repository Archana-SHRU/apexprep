/// <reference types="vite/client" />

/**
 * The frontend's environment variables, typed.
 *
 * Only one exists, and it is the API's base URL. Typing it means `import.meta.env.VITE_API_BASE_URL` is checked
 * rather than being `any`, which is the whole point of the rule against `any` in this integration: an
 * environment variable read with a typo would otherwise silently become `undefined` at runtime.
 *
 * Anything named `VITE_*` is inlined into the browser bundle and is therefore public. No secret goes here.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
