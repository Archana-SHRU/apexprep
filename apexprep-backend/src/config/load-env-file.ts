import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * For standalone scripts (migrate, seed, SQL tests) that run outside Nest.
 * Uses Node's built-in loader (Node >= 21.7); variables already set in the real
 * environment take precedence over the file.
 */
export function loadEnvFile(file = '.env'): void {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) process.loadEnvFile(path);
}
