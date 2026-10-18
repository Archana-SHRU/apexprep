import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/database/schema';
import { closeDb, createTestApp, db, type TestApp } from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Platform behaviour (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  describe('OpenAPI', () => {
    it('documents every auth endpoint and the error shape', async () => {
      const res = await t.http().get('/docs/openapi.json');
      expect(res.status).toBe(200);
      const doc = res.body as Json;
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining([
          '/v1/auth/register',
          '/v1/auth/login',
          '/v1/auth/refresh',
          '/v1/auth/logout',
          '/v1/auth/me',
          '/v1/auth/verify-email',
          '/v1/auth/resend-verification',
          '/v1/tracks',
          '/v1/tracks/{trackId}/tree',
          '/v1/subtopics/{id}/theory',
          '/v1/admin/tracks',
          '/v1/admin/topics/{topicId}/subtopics',
          '/v1/admin/subtopics/{subtopicId}/theory-blocks',
          '/v1/admin/questions',
          '/v1/admin/questions/{id}/publish',
          '/v1/admin/questions/{id}/preview',
          '/v1/me/profile',
          '/v1/admin/students',
          '/v1/admin/users/{id}/status',
          '/v1/admin/tenants',
        ]),
      );
      expect(doc.paths['/v1/auth/me'].get.security).toEqual([{ bearer: [] }]);
      expect(doc.paths['/v1/auth/login'].post.responses['200'].content['application/json'].schema.$ref).toMatch(/AuthResponseDto/);
      expect(doc.components.schemas.ErrorResponseDto).toBeDefined();
      expect(JSON.stringify(doc.components.schemas.UserDto)).not.toMatch(/password|hash/i);
    });
  });

  describe('request ids', () => {
    it('generates one per request and returns it in the header and in error bodies', async () => {
      const res = await t.http().get('/v1/auth/me');
      const id = res.headers['x-request-id'] as string;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect((res.body as Json).error.requestId).toBe(id);
    });

    it('keeps a well-formed incoming id and replaces a malformed one', async () => {
      const kept = await t.http().get('/v1/health/live').set('X-Request-Id', 'gateway-abc-123');
      expect(kept.headers['x-request-id']).toBe('gateway-abc-123');
      const replaced = await t.http().get('/v1/health/live').set('X-Request-Id', 'bad id with spaces <script>');
      expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('CORS', () => {
    it('allows the configured frontend origin with credentials', async () => {
      const res = await t
        .http()
        .options('/v1/auth/login')
        .set('Origin', 'http://localhost:5173')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,authorization');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-expose-headers']).toMatch(/X-Request-Id/);
    });

    it('does not grant any other origin', async () => {
      const res = await t.http().options('/v1/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    describe('local development origins (CORS_ORIGINS unset outside production)', () => {
      let dev: TestApp;
      beforeAll(async () => {
        dev = await createTestApp({ CORS_ORIGINS: '' }); // empty = unset → the development default
      });
      afterAll(async () => {
        await dev.close();
      });

      const preflight = (origin: string) =>
        dev
          .http()
          .options('/v1/auth/forgot-password')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', 'content-type');

      it.each(['http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174'])(
        'answers the preflight from %s with its own origin and credentials',
        async (origin) => {
          const res = await preflight(origin);
          expect(res.status).toBe(204);
          expect(res.headers['access-control-allow-origin']).toBe(origin); // echoed exactly, never '*'
          expect(res.headers['access-control-allow-credentials']).toBe('true');
          expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
          expect(res.headers['access-control-allow-headers']).toMatch(/Content-Type/i);
          expect(res.headers['vary']).toMatch(/Origin/);
        },
      );

      it('the actual request from an allowed origin carries the CORS headers too', async () => {
        const res = await dev.http().post('/v1/auth/forgot-password').set('Origin', 'http://localhost:5174').send({ email: 'nobody@example.test' });
        expect(res.status).toBe(202);
        expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5174');
        expect(res.headers['access-control-allow-credentials']).toBe('true');
      });

      it.each(['https://evil.example', 'http://localhost:5175', 'https://localhost:5173', 'http://localhost', 'null', 'http://localhost:5173.evil.example'])(
        'grants nothing to %s',
        async (origin) => {
          // No Access-Control-Allow-Origin means the browser refuses the response. (The cors library sends
          // Allow-Credentials on every reply; on its own it grants nothing.)
          const res = await preflight(origin);
          expect(res.headers['access-control-allow-origin']).toBeUndefined();
        },
      );
    });
  });

  describe('safe responses', () => {
    it('sets security headers and hides the framework', async () => {
      const res = await t.http().get('/v1/health/live');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('answers unknown routes in the standard error format', async () => {
      const res = await t.http().get('/v1/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: expect.any(String) } });
    });

    it('serves every route under /v1 only', async () => {
      expect((await t.http().get('/health/live')).status).toBe(404);
    });
  });

  describe('schema mirror', () => {
    const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));

    const MIRRORED = [
      'tenants',
      'users',
      'refresh_tokens',
      'user_tokens',
      'audit_log',
      'tracks',
      'learner_tracks',
      'subjects',
      'chapters',
      'topics',
      'subtopics',
      'content_assets',
      'ingestion_jobs',
      'extracted_pages',
      'content_blocks',
      'questions',
      'question_options',
      'question_secondary_subtopics',
      'official_solutions',
      'engine_config',
      'review_tasks',
      'sessions',
      'session_items',
      'attempts',
      'ability_scores',
      'session_events',
      'explanations',
      'block_embeddings',
      'revision_notes',
      'generated_questions',
      'tutor_conversations',
      'tutor_messages',
      'visual_explanations',
      'syllabus_suggestions',
      'syllabus_suggestion_blocks',
      'benchmark_snapshots',
      'mock_tests',
      'test_sections',
      'test_items',
      'test_sessions',
      'test_item_responses',
    ];

    /**
     * Columns Drizzle deliberately does not mirror, with the reason. Anything else missing
     * from either side is drift and fails.
     */
    const UNMIRRORED_COLUMNS: Record<string, string[]> = {
      // pgvector type; only ever read and written through raw `sql` with an explicit cast.
      block_embeddings: ['embedding'],
    };

    it('mirrors exactly the tables the application uses', () => {
      expect(tables.map((x) => getTableConfig(x).name).sort()).toEqual([...MIRRORED].sort());
    });

    it.each(MIRRORED)(
      'Drizzle definition of %s matches the migrated table (names and nullability)',
      async (name) => {
        const table = tables.find((x) => getTableConfig(x).name === name)!;
        const declared = getTableConfig(table)
          .columns.map((c) => `${c.name}:${c.notNull ? 'NOT NULL' : 'NULL'}`)
          .sort();
        const { rows } = await db().query<{ column_name: string; is_nullable: string }>(
          `SELECT column_name, is_nullable FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'`,
          [name],
        );
        // A table whose migration was skipped on this server (pgvector) cannot be compared.
        // Skipping is reported rather than silent, and only ever for that reason.
        if (rows.length === 0) {
          expect(name).toBe('block_embeddings');
          console.warn(`[e2e] ${name} is not in this database (pgvector unavailable); mirror not compared`);
          return;
        }
        const ignored = new Set(UNMIRRORED_COLUMNS[name] ?? []);
        const actual = rows
          .filter((r) => !ignored.has(r.column_name))
          .map((r) => `${r.column_name}:${r.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`)
          .sort();
        expect(declared).toEqual(actual);
      },
    );
  });
});
