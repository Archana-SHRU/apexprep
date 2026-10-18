/**
 * Drives the student practice loop against a running server:  npm run beta:load
 *
 * The requirements set response-time targets, and the closed beta is the first time the platform meets
 * concurrent learners. This harness answers one question before that happens: at the concurrency the
 * beta will actually produce, which request is slowest, and by how much.
 *
 * It exercises the real HTTP path — log in, start a session, then repeat serve → answer — because that
 * is the sequence a learner produces and the only one whose cost is worth measuring. `/next` runs
 * question selection over a candidate pool and `/attempts` runs the engine update inside a
 * transaction, so these two requests are where time goes.
 *
 * WHAT THE NUMBERS MEAN, AND WHAT THEY DO NOT
 *
 * They are the *client's* view: connect, send, receive. They include the network between this process
 * and the server, so running it on the same machine as the server measures the application, and
 * running it from elsewhere measures the application plus the path to it. Neither is "the production
 * latency" — a figure from this harness is a comparison against another run of this harness, which is
 * what makes a regression visible. It reports p50, p90, p99 and the maximum, because an average hides
 * exactly the request a learner complains about.
 *
 * It creates no data of its own: it needs a cohort that already exists, which
 * `npm run beta:learners` produces reproducibly. Every learner answers real questions, so the run
 * leaves attempts behind — point it at a development or staging database, never at a real one.
 *
 * A NOTE ON 429s
 *
 * Logging in is rate-limited (NFR-S4), and this harness logs everyone in at the start of a run. With
 * many learners, or several runs in quick succession, some logins are refused with 429 and those
 * learners are reported as unable to complete a session. That is the limiter working, not a fault:
 * raise `--ramp` to spread the logins out, use fewer learners, or wait for the window to pass. The
 * limiter is deliberately not bypassed here — a harness that could would be measuring a system nobody
 * is going to run.
 *
 * Usage:
 *   npm run beta:load -- --base=http://127.0.0.1:3000 --tenant=dev-sandbox \
 *                        --seed=autumn-beta --learners=20 --questions=10
 *   npm run beta:load -- ... --ramp=400        # spread logins out, to avoid the login limiter
 */
import { loadEnvFile } from '../src/config/load-env-file';

interface Options {
  base: string;
  tenantSlug: string;
  seed: string;
  learners: number;
  questions: number;
  rampMs: number;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (hit === undefined) return undefined;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
  };
  const seed = get('seed');
  if (!seed) throw new Error('--seed is required: it names the cohort made by `npm run beta:learners`');
  const base = (get('base') ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  if (/^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(base) && get('force') === undefined) {
    throw new Error(`refusing to load-test ${base}: pass --force if that host is really a test environment`);
  }
  return {
    base,
    seed,
    tenantSlug: get('tenant') ?? 'dev-sandbox',
    learners: Number(get('learners') ?? 10),
    questions: Number(get('questions') ?? 10),
    rampMs: Number(get('ramp') ?? 50),
  };
}

/** Mirrors the derivation in make-beta-learners.ts, so no credentials have to be passed around. */
async function cohortCredentials(seed: string, learners: number): Promise<{ email: string; password: string }[]> {
  const { createHash } = await import('node:crypto');
  const slug = seed.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return Array.from({ length: learners }, (_, i) => {
    const index = i + 1;
    return {
      email: `beta-${slug}-${String(index).padStart(3, '0')}@beta.invalid`,
      password: `Beta-${createHash('sha256').update(`${seed}:password:${index}`).digest('hex').slice(0, 12)}!7`,
    };
  });
}

interface Sample {
  label: string;
  ms: number;
  status: number;
  /** True when this status is a normal outcome rather than a fault — see `expected`. */
  ok: boolean;
}

const samples: Sample[] = [];

/**
 * Times one request and returns its status and parsed body.
 *
 * The body is read *inside* the measurement, because a response the client has not finished reading
 * is not a response a learner has received. It is returned here rather than re-read by the caller: a
 * `Response` body can only be consumed once, and cloning it to parse afterwards was how an earlier
 * version of this file managed to time a request and then fail to read it.
 */
async function timed(
  label: string,
  run: () => Promise<Response>,
  /**
   * Statuses that are a normal part of the flow rather than a fault. `/next` answers 409 when the
   * sub-topic has no question left to serve, which is how a session ends — counting that as an error
   * would leave the error column reading 6 on a run in which nothing went wrong, and a column that
   * cries wolf is worse than no column.
   */
  expected: readonly number[] = [200, 201],
): Promise<{ status: number; body: unknown }> {
  const started = process.hrtime.bigint();
  const res = await run();
  const text = await res.text().catch(() => '');
  samples.push({
    label,
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    status: res.status,
    ok: expected.includes(res.status),
  });
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** One learner's whole session, exactly as the app would drive it. */
async function oneLearner(opts: Options, creds: { email: string; password: string }): Promise<string | null> {
  const login = await fetch(`${opts.base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: creds.email, password: creds.password, tenantSlug: opts.tenantSlug }),
  });
  const loginBody = (await login.json().catch(() => ({}))) as { accessToken?: string };
  if (!login.ok || !loginBody.accessToken) return `login failed for ${creds.email} (${login.status})`;
  const auth = { authorization: `Bearer ${loginBody.accessToken}`, 'content-type': 'application/json' };

  // The learner's own tracks, which is where the primary track comes from.
  const tracks = await timed('GET /me/tracks', () => fetch(`${opts.base}/v1/me/tracks`, { headers: auth }));
  if (tracks.status !== 200) return `GET /me/tracks failed (${tracks.status})`;
  const trackId = primaryTrackId(tracks.body);
  if (!trackId) return `${creds.email} is enrolled in nothing: run \`npm run beta:learners\` first`;

  const tree = await timed('GET /tracks/:id/tree', () =>
    fetch(`${opts.base}/v1/tracks/${trackId}/tree`, { headers: auth }),
  );
  if (tree.status !== 200) return `GET /tracks/:id/tree failed (${tree.status})`;
  const subtopicId = firstSubtopicId(tree.body);
  if (!subtopicId) return 'that track has no published sub-topic to practise';

  const start = await timed('POST /practice/sessions', () =>
    fetch(`${opts.base}/v1/practice/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ subtopicId }),
    }),
  );
  const sessionId = (start.body as { session?: { id?: unknown } } | null)?.session?.id;
  if (start.status !== 201 || typeof sessionId !== 'string') return `starting a session failed (${start.status})`;

  for (let i = 0; i < opts.questions; i += 1) {
    const next = await timed(
      'GET /practice/sessions/:id/next',
      () => fetch(`${opts.base}/v1/practice/sessions/${sessionId}/next`, { headers: auth }),
      [200, 409], // 409 = nothing left to serve, which is how a session ends
    );
    if (next.status !== 200) break; // out of questions, or the session was paused: both are normal
    const item = itemId(next.body);
    if (!item) break;
    const response = answerFor(next.body);
    if (response === null) {
      // A question shape this harness does not answer. Skipping it keeps the run going and keeps the
      // error columns meaningful: a 4xx in the report should mean the server refused something it
      // should have accepted, not that the harness sent nonsense.
      await fetch(`${opts.base}/v1/practice/sessions/${sessionId}/next?skip=true`, { headers: auth });
      continue;
    }
    await timed('POST /practice/attempts', () =>
      fetch(`${opts.base}/v1/practice/attempts`, {
        method: 'POST',
        headers: { ...auth, 'idempotency-key': `load-${sessionId}-${i}-${Date.now()}` },
        body: JSON.stringify({ sessionItemId: item, response, totalTimeMs: 30_000 }),
      }),
    );
  }
  return null;
}

/**
 * A well-formed answer for whatever was served.
 *
 * Whether it is *right* does not matter — the engine costs the same either way — but it has to match
 * the question's shape, because a validation error is cheap and would make the timings a measurement
 * of the validation pipe rather than of practice.
 */
function answerFor(body: unknown): Record<string, unknown> | null {
  const question = (body as { question?: Record<string, unknown> } | null)?.question;
  if (!question) return null;
  const type = typeof question.type === 'string' ? question.type : '';
  const options = Array.isArray(question.options) ? (question.options as { key?: unknown }[]) : [];
  const firstKey = options.find((o) => typeof o.key === 'string')?.key as string | undefined;

  switch (type) {
    case 'single_correct':
    case 'multi_correct':
    case 'assertion_reason':
      return firstKey === undefined ? null : { optionKeys: [firstKey] };
    case 'integer':
    case 'numeric':
      return { value: '1' };
    case 'long_form':
      return { text: 'A written answer from the load-test harness.' };
    default:
      // matrix_match and anything added later: skipped rather than guessed at.
      return null;
  }
}

/** The learner's primary track, or their first one if none is marked primary. */
function primaryTrackId(body: unknown): string | undefined {
  if (!Array.isArray(body)) return undefined;
  const entries = body as { trackId?: unknown; isPrimary?: unknown; status?: unknown }[];
  const active = entries.filter((e) => e.status === 'active' && typeof e.trackId === 'string');
  const primary = active.find((e) => e.isPrimary === true) ?? active[0];
  return typeof primary?.trackId === 'string' ? primary.trackId : undefined;
}

function itemId(body: unknown): string | undefined {
  const item = (body as { item?: { id?: unknown } } | null)?.item;
  return typeof item?.id === 'string' ? item.id : undefined;
}

/** The first published sub-topic in a track's tree: subjects → chapters → topics → sub-topics. */
function firstSubtopicId(tree: unknown): string | undefined {
  const subjects = ((tree as { subjects?: unknown[] } | null)?.subjects ?? []) as { chapters?: unknown[] }[];
  for (const subject of subjects) {
    for (const chapter of (subject.chapters ?? []) as { topics?: unknown[] }[]) {
      for (const topic of (chapter.topics ?? []) as { subtopics?: { id?: unknown }[] }[]) {
        for (const sub of topic.subtopics ?? []) {
          if (typeof sub.id === 'string') return sub.id;
        }
      }
    }
  }
  return undefined;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function report(opts: Options, wallMs: number, failures: string[]): void {
  const byLabel = new Map<string, number[]>();
  const errors = new Map<string, number>();
  for (const s of samples) {
    if (!byLabel.has(s.label)) byLabel.set(s.label, []);
    byLabel.get(s.label)!.push(s.ms);
    if (!s.ok) errors.set(s.label, (errors.get(s.label) ?? 0) + 1);
  }

  console.log('');
  console.log(`# ${opts.learners} concurrent learners x up to ${opts.questions} questions against ${opts.base}`);
  console.log(`# wall clock ${(wallMs / 1000).toFixed(1)} s, ${samples.length} timed requests`);
  console.log('');
  console.log('request                              n     p50     p90     p99     max   4xx/5xx');
  for (const [label, values] of [...byLabel.entries()].sort()) {
    const sorted = [...values].sort((a, b) => a - b);
    const cell = (n: number) => `${n.toFixed(0)} ms`.padStart(7);
    console.log(
      `${label.padEnd(36)}${String(sorted.length).padStart(3)} ${cell(percentile(sorted, 50))} ${cell(
        percentile(sorted, 90),
      )} ${cell(percentile(sorted, 99))} ${cell(sorted[sorted.length - 1]!)}   ${errors.get(label) ?? 0}`,
    );
  }
  if (failures.length > 0) {
    console.log('');
    console.log(`${failures.length} learner(s) could not complete a session:`);
    for (const f of [...new Set(failures)].slice(0, 10)) console.log(`  - ${f}`);
  }
  console.log('');
  console.log('These figures are this harness measured against itself: compare runs, not absolutes.');
}

async function main(): Promise<void> {
  loadEnvFile();
  const opts = parseArgs(process.argv.slice(2));
  const creds = await cohortCredentials(opts.seed, opts.learners);

  const started = Date.now();
  // Ramped rather than all at once: fifty simultaneous logins measure argon2, not practice, and the
  // beta's learners do not arrive on the same millisecond either.
  const runs = creds.map(async (c, i) => {
    await new Promise((resolve) => setTimeout(resolve, i * opts.rampMs));
    return oneLearner(opts, c);
  });
  const results = await Promise.all(runs);
  report(
    opts,
    Date.now() - started,
    results.filter((r): r is string => r !== null),
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
