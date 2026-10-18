import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bandsByLevel, parseEngineParams, updateFactor } from '../../src/adaptive/engine-params';
import { SEED_ENGINE_PARAMS, engineParamsJson } from '../fixtures/engine-params';

const without = (path: string): Record<string, unknown> => {
  const copy = JSON.parse(JSON.stringify(SEED_ENGINE_PARAMS)) as Record<string, unknown>;
  const parts = path.split('.');
  let node = copy;
  for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>;
  delete node[parts[parts.length - 1]!];
  return copy;
};

const issuesFor = (params: unknown): string[] => {
  const parsed = parseEngineParams(params);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.issues.map((i) => i.field);
};

describe('engine parameters', () => {
  it('accepts the complete set the development seed carries', () => {
    const parsed = parseEngineParams(SEED_ENGINE_PARAMS);
    expect(parsed.ok).toBe(true);
  });

  it.each([
    'elo_scale',
    'k_student',
    'k_question',
    'cold_start',
    'level_bands',
    'initial_b_by_level',
    'target_success',
    'placement',
    'promotion',
    'demotion',
    'l1_protection',
    'l5_ceiling',
    'probable_guess',
    'probe',
    'inactivity_decay',
    'exclusion_days',
    'exclusion_includes_skipped',
    'near_duplicate',
    'content_gap',
    'benchmark',
    'rag',
  ])('refuses to run without %s instead of inventing a value', (key) => {
    expect(issuesFor(without(key))).toContain(`params.${key}`);
  });

  it.each([
    'k_student.initial_attempts',
    'k_student.low_calibration_threshold',
    'k_question.calibrated_after',
    'promotion.consecutive_correct',
    'promotion.within_expected_time_factor',
    'demotion.consecutive_incorrect',
    'probable_guess.requires_incorrect',
    'probable_guess.pause_session_after',
    'probe.every_n',
    'probe.levels_above_target',
    'probe.counts_towards_demotion',
    'inactivity_decay.theta_points_per_period',
    'content_gap.min_eligible',
    'benchmark.min_qualifying_students',
  ])('names the exact missing key: %s', (path) => {
    expect(issuesFor(without(path))).toContain(`params.${path}`);
  });

  it('rejects values outside their range', () => {
    expect(issuesFor(engineParamsJson({ target_success: 1 }))).toContain('params.target_success');
    expect(issuesFor(engineParamsJson({ target_success: 0 }))).toContain('params.target_success');
    expect(issuesFor(engineParamsJson({ elo_scale: 0 }))).toContain('params.elo_scale');
    expect(issuesFor(engineParamsJson({ cold_start: { level: 6, seed_from_parent_topic: true } }))).toContain('params.cold_start.level');
    expect(issuesFor(engineParamsJson({ probe: { ...(SEED_ENGINE_PARAMS.probe as object), every_n: 1 } }))).toContain('params.probe.every_n');
  });

  it('rejects a window smaller than the number of answers it requires', () => {
    expect(
      issuesFor(engineParamsJson({ promotion: { consecutive_correct: 2, within_expected_time_factor: 1.25, window: 3, correct_in_window: 4 } })),
    ).toContain('params.promotion');
    expect(issuesFor(engineParamsJson({ demotion: { consecutive_incorrect: 2, window: 3, incorrect_in_window: 4 } }))).toContain('params.demotion');
  });

  it('rejects level bands that are not contiguous, not five, or not open at the ends', () => {
    const bands = SEED_ENGINE_PARAMS.level_bands as { level: number; theta_min: number | null; theta_max: number | null }[];
    const gappy = bands.map((b) => (b.level === 3 ? { ...b, theta_min: 1150 } : b));
    expect(issuesFor(engineParamsJson({ level_bands: gappy }))).toContain('params.level_bands');

    const four = bands.slice(0, 4);
    expect(issuesFor(engineParamsJson({ level_bands: four }))).toContain('params.level_bands');

    const closed = bands.map((b) => (b.level === 1 ? { ...b, theta_min: 0 } : b));
    expect(issuesFor(engineParamsJson({ level_bands: closed }))).toContain('params.level_bands');
  });

  it('rejects an unknown update weight', () => {
    const guess = { ...(SEED_ENGINE_PARAMS.probable_guess as object), theta_update: 'double' };
    expect(issuesFor(engineParamsJson({ probable_guess: guess }))).toContain('params.probable_guess.theta_update');
  });

  it('rejects a stray key inside a known group, so typos are caught', () => {
    const probe = { ...(SEED_ENGINE_PARAMS.probe as object), evrey_n: 5 };
    expect(issuesFor(engineParamsJson({ probe }))).toEqual(expect.arrayContaining([expect.stringContaining('params.probe')]));
  });

  it('keeps bookkeeping keys the seed adds, such as the provisional flag', () => {
    const parsed = parseEngineParams(engineParamsJson({ provisional: true, provisional_keys: ['k_student'] }));
    expect(parsed.ok).toBe(true);
  });

  it('reports every problem at once, not just the first', () => {
    const broken = engineParamsJson({ elo_scale: -1, target_success: 2 });
    const fields = issuesFor(broken);
    expect(fields).toEqual(expect.arrayContaining(['params.elo_scale', 'params.target_success']));
  });
});

describe('helpers', () => {
  it('turns an update weight into a factor', () => {
    expect([updateFactor('skip'), updateFactor('half'), updateFactor('full')]).toEqual([0, 0.5, 1]);
  });

  it('sorts bands by level', () => {
    const parsed = parseEngineParams(SEED_ENGINE_PARAMS);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(bandsByLevel(parsed.value).map((b) => b.level)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('the development seed', () => {
  // Guards against the seed and the test fixture drifting apart, and against the seed
  // carrying a parameter set the engine could not run on.
  const seedSql = readFileSync(resolve(__dirname, '../../database/seeds/dev/001_dev_content.sql'), 'utf8');
  const json = seedSql.slice(seedSql.indexOf('$json${') + '$json$'.length, seedSql.indexOf('}$json$') + 1);

  it('carries a complete, valid parameter set', () => {
    const parsed = parseEngineParams(JSON.parse(json));
    expect(parsed.ok ? [] : parsed.issues).toEqual([]);
  });

  it('matches the parameters the tests use', () => {
    expect(JSON.parse(json)).toMatchObject(
      Object.fromEntries(Object.entries(SEED_ENGINE_PARAMS).filter(([k]) => k !== 'provisional')),
    );
  });

  it('is marked provisional until the requirements document supplies the values', () => {
    expect((JSON.parse(json) as { provisional?: boolean }).provisional).toBe(true);
  });
});

describe('the unspecified values are declared, not hidden', () => {
  // The requirements state a rule for these but no number. Each one must be listed in the
  // seed under `provisional_keys` AND documented as NOT SPECIFIED in docs/DECISIONS.md §C,
  // so a chosen value can never quietly pass for a required one.
  const seedSql = readFileSync(resolve(__dirname, '../../database/seeds/dev/001_dev_content.sql'), 'utf8');
  const seedParams = JSON.parse(seedSql.slice(seedSql.indexOf('$json${') + '$json$'.length, seedSql.indexOf('}$json$') + 1)) as {
    provisional?: boolean;
    provisional_keys?: string[];
  };
  const decisions = readFileSync(resolve(__dirname, '../../docs/DECISIONS.md'), 'utf8');

  it('lists the unspecified keys in the seed', () => {
    expect(seedParams.provisional).toBe(true);
    expect(seedParams.provisional_keys).toEqual(
      expect.arrayContaining([
        'level_bands',
        'initial_b_by_level',
        'inactivity_decay.per_period_days',
        'inactivity_decay.theta_points_per_period',
        'inactivity_decay.max_total_points',
        'near_duplicate.trigram_similarity',
        'near_duplicate.exclude_days',
        'probable_guess.question_update',
        'probe.updates_question_b',
      ]),
    );
  });

  it.each(SEED_ENGINE_PARAMS.provisional_keys as string[])('documents %s as NOT SPECIFIED in DECISIONS §C', (key) => {
    const row = decisions.split('\n').find((line) => line.includes(`\`${key}\``) && line.includes('NOT SPECIFIED'));
    expect(row).toBeDefined();
  });

  it('does not mark a stated value as unspecified', () => {
    const stated = ['elo_scale', 'k_student', 'k_question', 'cold_start', 'target_success', 'promotion', 'demotion', 'exclusion_days'];
    for (const key of stated) expect(SEED_ENGINE_PARAMS.provisional_keys as string[]).not.toContain(key);
  });
});
