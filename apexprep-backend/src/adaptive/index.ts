/**
 * The adaptive engine: pure TypeScript with no Nest, database or network imports, so it
 * runs in unit tests without infrastructure and can be replayed against stored attempts.
 *
 * Every threshold comes from an `EngineParams` argument, loaded from the active
 * `engine_config` version. Nothing in here has a default — see engine-params.ts.
 */
export * from './engine-params';
export * from './elo';
export * from './levels';
export * from './guess';
export * from './decay';
export * from './selection';
export * from './attempt-update';
export * from './time';
