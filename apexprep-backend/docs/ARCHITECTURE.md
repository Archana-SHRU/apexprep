# ApexPrep Backend — Architecture

Status: **Phases 1–4 implemented** (foundation; auth, users, tenants, RBAC; syllabus, theory, question bank; engine configuration and the adaptive engine core). Sections marked _(pending doc)_ depend on
`Adaptive-Practice-App-Requirements.docx`, which has not been provided yet. See
[DECISIONS.md](./DECISIONS.md) for every ambiguity and the default chosen.

---

## 1. Stack decisions

| Concern | Choice | Why |
| --- | --- | --- |
| Framework | **NestJS 11** (Express adapter) | The required folder layout is literally a set of Nest modules. DI makes the two things we must keep swappable — the AI provider and the job queue — plain interface bindings. Guards give RBAC + tenant checks in one place, `@nestjs/swagger` produces OpenAPI from the same DTOs that validate requests, `@nestjs/bullmq` wires workers. Plain Fastify would mean hand-building all of that. Express over the Fastify adapter because multer's upload limits and file filters are first-class there. |
| ORM | **Drizzle ORM** + `node-postgres` | This schema leans hard on PostgreSQL: pgvector, `tsvector` generated columns, CHECK constraints, partial unique indexes for soft deletes, composite tenant FKs, triggers. Drizzle models `vector`, checks and partial indexes natively and its query builder is SQL-shaped, which matters for analytics aggregates and hybrid retrieval. Prisma would need `Unsupported("vector")` + `$queryRaw` for every vector operation and hand-edited migrations for the rest anyway. No query-engine binary to ship. |
| Migrations | **SQL-first** (`database/migrations/*.sql`) | Triggers, CHECKs and HNSW indexes have to be written in SQL regardless, so hand-reviewed SQL is the source of truth. A small runner applies them in order and checksums them. The Drizzle TypeScript schema mirrors the SQL and is diffed with `drizzle-kit pull` in CI to catch drift. |
| Database | PostgreSQL 16 + pgvector ≥ 0.8 + pg_trgm + pgcrypto | pgvector 0.8 iterative index scans keep filtered ANN (`WHERE subtopic_id = …`) accurate. |
| Queue | Redis 7 + BullMQ | Ingestion stages, embeddings, nightly benchmark snapshots, inactivity decay, report generation. |
| Auth | argon2id, JWT access (15 min), opaque rotating refresh tokens (hashed, family revocation on reuse) | See §5. |
| Validation | `class-validator` DTOs (requests), `zod` (env + engine_config params) | |
| Tests | Jest + Supertest; engine core is pure TS and runs without a DB | |

## 2. Shape: modular monolith

One deployable API process plus one worker process built from the same codebase
(`main.ts` / `worker.ts`). Modules talk through exported services, never through each
other's tables. No microservices.

```
apexprep-backend/
├── src/
│   ├── main.ts               API bootstrap (helmet, CORS, /v1 versioning, Swagger, validation)
│   ├── worker.ts             BullMQ worker bootstrap (not yet: see §9, the queue boundary)
│   ├── app.module.ts
│   ├── config/               zod-validated environment
│   ├── database/             Drizzle client, schema mirror, migration runner, seed runner
│   ├── common/               guards, decorators, filters, pagination, error codes, tenant context
│   ├── health/               liveness / readiness
│   ├── auth/                 register, login, refresh rotation, logout, email verification
│   ├── users/                profile, onboarding, admin student management
│   ├── tenants/              tenant settings (benchmarking / focus-tracking switches)
│   ├── syllabus/             tracks → subjects → chapters → topics → subtopics, tree, theory, authoring
│   ├── questions/            question bank, student-safe projection, reports on questions
│   ├── practice/             sessions, /next, attempts (idempotent), session events
│   ├── adaptive/             PURE engine: Elo, levels, guesses, decay, selection — no Nest/DB imports
│   ├── engine-config/        versioned tunables, activation, audit
│   ├── explanations/         resolution chain (official → RAG → general), retrieval, grounding, safety
│   ├── ai/                   AiProvider interface + providers (Gemini, Claude), embeddings
│   ├── storage/              ObjectStorage boundary + local and in-memory adapters, safe keys
│   ├── pdf/                  PdfDocument (validation + text layer) and the OcrProvider boundary
│   ├── ingestion/            upload, the job queue boundary, the pipeline stages, review, publishing
│   ├── analytics/            student analytics + benchmark snapshots
│   ├── reports/              generated performance reports
│   ├── admin/                admin-facing controllers composing the services above
│   └── audit/                append-only audit writer + query API
├── database/
│   ├── migrations/           0001 … 0012 SQL (source of truth)
│   └── seeds/dev/            development-only seed (refuses to run in production)
├── test/
│   ├── sql/                  database-level tests (constraints, triggers, tenant FKs)
│   ├── unit/                 adaptive engine etc.
│   └── e2e/                  HTTP tests against a real database
├── docs/                     this file, DECISIONS.md, FRONTEND-CONTRACT.md
├── Dockerfile  docker-compose.yml  .env.example  package.json  README.md
```

## 3. Data model

25 required tables plus 7 supporting tables (flagged in DECISIONS.md §A; `learner_tracks` is the
Phase 8 addition).

```
tenants ─┬─ users ─┬─ refresh_tokens, user_tokens
         │         └─ learner_tracks ──→ tracks       (a learner is in one or more tracks)
         ├─ tracks → subjects → chapters → topics → subtopics      (strict tree)
         ├─ content_assets ── ingestion_jobs ── extracted_pages ── content_blocks ── block_embeddings
         ├─ questions ─┬─ question_options, question_secondary_subtopics, question_assets
         │             ├─ official_solutions, explanations
         │             └─ review_tasks  (also targets content_blocks / explanations)
         ├─ engine_config (versioned, one active per tenant)
         ├─ sessions ── session_items ── attempts (immutable)   session_events (append-only)
         ├─ ability_scores  (projection of attempts, per user × subtopic)
         ├─ benchmark_snapshots, reports
         └─ audit_log (append-only)
```

Conventions, all enforced in SQL:

- `uuid` primary keys (`gen_random_uuid()`); `tenant_id` on every tenant-owned row.
- `created_at` / `updated_at` (trigger-maintained); `deleted_at` on soft-deletable rows,
  with uniqueness expressed as partial indexes `WHERE deleted_at IS NULL`.
- **Composite tenant foreign keys.** Each parent has `UNIQUE (tenant_id, id)`; children
  reference `(tenant_id, parent_id)`. A row can never point at another tenant's row, even
  through an application bug.
- Enumerations are `text` + `CHECK` (easier to evolve than PG enums).
- **`attempts` is immutable** — `UPDATE`, `DELETE` and `TRUNCATE` raise `AP001`.
- **`audit_log` is append-only** — same trigger family.
- **`engine_config` versions are immutable** — only activation may change, and every
  insert/activation writes its own `audit_log` row from inside the database.
- Attempts store `difficulty_b_at_attempt`, `question_version`, `theta_before`,
  `expected_score` and `engine_config_id`, so `ability_scores` and question `difficulty_b`
  can be rebuilt by replaying attempts in order.
- Publishing a question runs a DB-side validator (`AP002`) — e.g. single-correct must
  have exactly one correct option, numeric must have a value and tolerance.
- Focus events are refused by the database (`AP003`) when tracking was off for the session,
  and benchmark rows cannot hold values for a cohort below the minimum size.
- CHECKs are written so NULL can never satisfy them (a NULL CHECK passes in SQL; the
  test suite caught two such cases during Phase 1).
- Custom SQLSTATEs map to HTTP in the global exception filter (Phase 2):
  `AP001` → 409, `AP002` → 422, `AP003` → 409, `AP004` → 422, `23505` → 409,
  `23503` → 422, `23514` → 422.
- `review_tasks` may name a **job** as its target (migration 0012), for a page that could not be
  read and therefore produced no block; every other task still names a block, question,
  explanation or sub-topic.
- `block_embeddings.embedding` is an un-dimensioned `vector` with a `dims` check and a
  **per-model partial HNSW index** on `embedding::vector(N)`, so switching AI provider
  (768-d Gemini ↔ 1024/1536-d others) means adding an index and re-embedding, not a
  destructive migration.

## 4. Tenant isolation (three layers)

1. **Identity:** `tenant_id` comes only from the verified JWT, never from path, query or
   body. SUPER_ADMIN may act on another tenant only through explicit `/v1/admin/tenants/:id/…`
   routes, and each such action is audited.
2. **Application:** every repository method takes `tenantId` as its first argument and
   filters on it; there is no un-scoped query helper.
3. **Database:** composite FKs (above). Row-Level Security is a planned hardening step
   once the connection-per-request pattern is in place (DECISIONS.md §B7).

Tests assert a user of tenant A gets `404` (not `403`) on tenant B's ids, so existence
does not leak.

## 5. Authentication

- `POST /v1/auth/register`, `/login`, `/refresh`, `/logout`, `/verify-email`, `/resend-verification`, `/forgot-password`, `/reset-password`.
- Passwords: argon2id (memory-hard, OWASP first choice). Never logged, never returned.
- Access token: JWT (HS256), 15 min, claims `sub`, `tid`, `role`, `ver`, `typ`, `jti`. Minimal
  fixed-algorithm implementation on node:crypto (DECISIONS.md §B17). The guard re-reads the
  user and tenant on every request; role, status and tenant come from the database, not the claims.
- Refresh token: 256-bit random opaque value, stored only as SHA-256 hash, 30-day
  expiry, delivered in an `HttpOnly; Secure; SameSite=Strict` cookie (and optionally
  the body for non-browser clients). **Rotation:** every refresh issues a new token and
  revokes the old one; presenting a revoked token revokes the whole family (theft
  detection).
- Email verification: single-use hashed tokens in `user_tokens`; delivery goes through a
  `MailService` interface (console in dev, memory in tests, none in production until a
  provider is chosen; DECISIONS.md §B20).
- Account lockout after `AUTH_MAX_FAILED_LOGINS` consecutive failures; unknown emails take
  the same time as wrong passwords (a dummy argon2 verification).
- RBAC: `STUDENT`, `ADMIN`, `SUPER_ADMIN` → permissions (`src/common/auth/permissions.ts`).
  Global guards in order: `ThrottlerGuard` → `JwtAuthGuard` (everything is authenticated
  unless `@Public()`) → `AuthorizationGuard` (`@RequirePermissions`, `@Roles`, `@TenantScoped`).

## 6. Answer-leakage prevention

- Student question payloads are built from an **explicit column allow-list**
  (`StudentQuestionView`); answer columns (`is_correct`, `correct_numeric`,
  `numeric_tolerance`, `matrix_answer`, official solutions) are never selected on that path.
- Correctness is decided **server-side** in `POST /v1/practice/attempts`; the response
  to that call is the first place the answer appears, and only for that attempt.
- `GET /v1/questions/{id}/explanation` requires the caller to have a submitted attempt on
  that question (admins exempt).
- An automated test serialises every student-facing response and fails on any
  forbidden key (`test/e2e/question-leakage.e2e-spec.ts`, all seven question types), and a
  unit test asserts the allow-lists themselves (`test/unit/student-question-view.spec.ts`),
  so a new column cannot quietly join the projection.
- Hint **text** is not in the student payload either — only `hintCount`. Hints are revealed
  through the practice API so the count lands on the attempt.
- `GET /v1/subtopics/{id}/theory` returns `kind = 'theory'` blocks only, so question and
  solution blocks extracted from the same page are never served as theory.

## 7. Syllabus visibility and the question bank

**One visibility rule, one place.** `SyllabusRepository` answers every read in one of two
views: `published` (students) or `all` (content admins). A node is visible to a student only
when it *and every ancestor* is published and not deleted — children are only loaded under
visible parents, and single-node lookups join the whole chain up to the track. Anything else
answers **404**, never 403, so ids don't leak. Student routes (`/v1/tracks`, `/v1/subjects/{id}`,
…) always use the published view; `/v1/admin/...` uses `all` and includes each node's status.

`GET /v1/tracks/{id}/tree` answers the Learn pages in one request: subjects → chapters →
topics → sub-topics, with `questionCount` (published questions by primary sub-topic, rolled
up), `hasTheory`, and `mastery` — which is `null` until the engine and analytics phases.

**Question bank.** Answer shape is validated per type in pure TypeScript
(`src/questions/question-shape.ts`) on every write, so a stored question already satisfies
the database's deferred publish validator; AP002 stays the backstop and surfaces as 422
`NOT_PUBLISHABLE`. New questions start as drafts, take their starting `difficulty_b` from the
active `engine_config` (no literals in code), and move draft → published → retired. Nothing
is hard-deleted: attempts reference questions by id and version, and the database bumps the
version whenever content or the answer key changes.

## 8. Adaptive engine

Pure functions in `src/adaptive/` — no Nest, database or network imports, so the engine
runs in unit tests without infrastructure and can be replayed against stored attempts.
Every function takes an `EngineParams` argument loaded from the active `engine_config`
version: **there is not one threshold literal in engine code.**

```
E  = 1 / (1 + 10^((b − θ) / elo_scale))     expectation of success
θ' = θ + K_s (S − E)                        student, per sub-topic
b' = b + K_q (E − S)                        question
b* = θ + elo_scale · log10(1/p − 1)         difficulty where P(correct) = target_success
```

| File | What it decides |
| --- | --- |
| `engine-params.ts` | The complete parameter schema (zod). **No key has a default**: a version missing one is rejected with the key named, so the engine can never run on an invented number. |
| `elo.ts` | The four formulas above, plus rounding to what `numeric(8,2)` stores. |
| `levels.ts` | Which band θ falls in, cold start, promotion and demotion over their windows, the L1 floor and the L5 ceiling. |
| `guess.ts` | Probable-guess detection from answer time against `expected_time_seconds`, and how much such an attempt is allowed to move. |
| `decay.ts` | Inactivity decay after `after_days`, by period, capped and floored. |
| `selection.ts` | Eligibility (exclusion window, skipped items, near-duplicates), the reason for this pick (cold start → placement → probe → adaptive), ranking by \|b − b*\|, the content-gap signal and the deliberate fallback. |
| `attempt-update.ts` | One graded attempt end to end: E → θ and b updates → level decision, with probe and guess weights multiplied in. |

Two decisions worth naming. **Weights multiply**: a probable guess on a probe counts as
little as both rules allow, and an ungraded long-form answer moves nothing at all.
**θ and the working level are reported separately**: the ladder maintains the level,
`level_bands` say which band θ now sits in, and selection targets b\* from θ — so a
disagreement between the two changes what is reported, never what is served.

The rules as configured (values in DECISIONS.md §C):

| Rule | Behaviour |
| --- | --- |
| K_s | 32 for a student's first 20 attempts in a sub-topic, then 16; halved again against a question with fewer than 10 calibrating attempts |
| K_q | 24 while the question's `calibration_n` is under 50, then 8 |
| Cold start | L2, or seeded from the student's parent-topic ability when they have practised its other sub-topics |
| Promotion | 2 correct in a row, each within 1.25× the expected time — or 3 correct of the last 4 |
| Demotion | 2 incorrect in a row — or 3 incorrect of the last 5; never below L1 |
| Probable guess | incorrect **and** under 25% of the expected time: stored, but excluded from the ability update and the ladder; 3 in a session pauses it |
| Probe | every 5th question, aimed half a level above the usual target; updates θ but is skipped by the demotion counters |
| Selection | targets ~72% success, excludes anything attempted in the last 30 days and near-duplicates of what was seen |
| Content gap | under 5 eligible questions → widen to the parent topic and raise a content-gap alert |
| Inactivity | θ decays after 21 days without practice in the sub-topic |

`engine_config` versions are immutable, one is active per organisation, and the database
itself writes the audit row for every create, activate and deactivate. Reading parameters
for the engine validates them in full and fails loudly (`ENGINE_CONFIG_INVALID`, listing
the keys); the question bank only needs `initial_b_by_level`, so authoring keeps working
while other tunables are still being settled.

A unit test scans the engine's behavioural files and fails if any stated threshold appears
as a literal, so a future change cannot quietly move a value out of configuration and into
code.

## 8b. The practice flow: how the engine reaches a request

`src/practice/` is the only module that wires the engine to HTTP. It owns no adaptive rule:
it loads state, calls the pure functions above, and writes what they return. Every number it
uses comes from the active `engine_config` version.

| File | Responsibility |
| --- | --- |
| `practice.controller.ts` | Six routes, all behind the `practice:use` permission, so staff accounts cannot reach them. |
| `practice.service.ts` | Sessions: open (or resume), the cold start, inactivity decay, `/next`, focus events, ending. |
| `attempts.service.ts` | One submission, in one transaction: grade, apply the engine, write the attempt, calibrate the question, write the projection. |
| `grading.ts` | Server-side correctness for all seven question types, and the answer key disclosed afterwards. |
| `decimal.ts` | Exact decimal comparison on `BigInt` for numeric tolerance, because `\|4.2 − 4.1\| ≤ 0.1` is false in binary floating point. |
| `practice.repository.ts` | All practice data access, tenant-scoped; the candidate pool and the ladder window come straight out of `attempts`. |
| `ability-replay.ts` / `ability-rebuild.service.ts` | Rebuild `ability_scores` by replaying attempts through `applyAttempt`. |

**`GET /practice/sessions/:id/next`.** Refuse if the session is paused (three flagged
guesses). If a question is already outstanding, return that same one — a refresh cannot skip
a question — unless `?skip=true`, which marks it skipped so the exclusion rules see it. Load
the candidate pool (every published question of the sub-topic with when this student last saw
each one) and the duplicate groups already seen, and hand both to `selectNextQuestion`. If it
reports the pool is thin, widen to the sibling sub-topics of the parent topic and prefer the
wider pool only when it yields more eligible questions; open one `content_gap` review task
either way. If nothing is eligible at all, `fallbackSelection` serves the question seen
longest ago, labelled `content_gap_fallback`; if there are no questions at all, the answer is
`409 NO_ELIGIBLE_QUESTIONS`. The question itself goes through the question bank's student-safe
projection, so `/next` cannot leak an answer key even by accident.

**`POST /practice/attempts`.** Requires an `Idempotency-Key`; a replayed key returns the
stored attempt with `replayed: true` and grades nothing again. Then, in one transaction:
lock the served item (`FOR UPDATE`; it must still be `served` and belong to the caller), lock
the session, re-check the pause rule, grade the response **from the answer key on the
server**, read the ladder window out of `attempts`, call `applyAttempt`, insert the immutable
attempt, move the question's own `b` and `calibration_n`, and write the ability projection —
all committing together. The request DTO has no field for correctness, and the global
validation pipe rejects a body that invents one.

**Derived, not accumulated.** The promotion and demotion counters come from `attempts` on
every submission (graded, non-guess attempts since the level last changed), and the
three-guesses pause is a `count(*)` over the session's attempts. The one thing that cannot be
derived is where the current level started, which is why `ability_scores.ladder_reset_at`
exists (migration 0009). It is written from a SQL expression reading the attempt's own
`created_at`: a `timestamptz` keeps microseconds and a JavaScript `Date` does not, so a
round-tripped boundary would be up to a millisecond early and would let the attempt that
caused a promotion count towards the next one.

**The projection is only a projection.** `AbilityRebuildService` replays a student's attempts
through the same engine and either reports which columns disagree or writes the result back.
For that to be possible the attempt row has to carry every input the engine used, which is
why migration 0010 snapshots `calibration_n_at_attempt` and
`expected_time_seconds_at_attempt` alongside the `theta_before`, `difficulty_b_at_attempt`,
`expected_score` and `engine_config_id` that were already there. Inactivity decay lands
between attempts rather than on one, so a replay sees it as a mismatch against the next
attempt's recorded `theta_before`; it follows the recorded value and reports the difference
instead of diverging silently.

## 9. Content ingestion pipeline _(Phase 7 — implemented)_

```
POST /v1/admin/ingestion/assets  (raw application/pdf body)
  → size → type from the file's own header → encryption + page count → SHA-256 duplicate
  → store the object  → write content_assets + ingestion_jobs in one transaction  → enqueue
      ↓ (background, one handler behind the JobQueue interface)
  extract the text layer, page by page          → extracted_pages
  OCR only the pages whose text layer is thin   → OcrProvider, or a review task if it cannot run
  segment and classify   {theory|question|solution|ambiguous} + reason + confidence
  map to an EXISTING published sub-topic        + confidence + reason  (never creates a node)
  read the questions out of the question blocks (Phase 3's validateQuestionShape)
      ↓ one transaction: replace pages, replace machine blocks, replace machine tasks
  match each solution to its question           (numbering → stated answer → proximity → terms)
  near-duplicate check against the question bank (pg_trgm, engine-config threshold)
  open a review task for every judgement a person has to make
  record the gates and the auto-approval verdict on each block
  → ingestion_jobs.status = 'awaiting_review'
      ↓ (admin, one block at a time)
  approve · reject · edit · reclassify · merge · split      → all audited
  → POST …/blocks/:id/publish  → quality gates → QuestionsAdminService.create + publish
                                               + setOfficialSolution, or published theory
```

Four properties hold the design together.

**The stage names are the ones the database already had.** `ingestion_jobs.status` was fixed by
migration 0003 with fourteen values, and the requirements name the stages slightly differently
("uploaded", "validating", "mapping", "ready_for_review"). `STAGES` in `ingestion.pipeline.ts` maps
one onto the other, so progress is observable without a migration to rename anything.

**Every stage is idempotent.** A re-run replaces this job's pages, its machine-written blocks and its
machine-opened review tasks rather than adding a second set, and a block a person has touched —
edited, reclassified, merged, split, approved, published, rejected — is left exactly as they left it
(`IngestionRepository.replaceMachineBlocks`). A re-run also skips re-inserting content whose hash a
kept block already carries, so it does not hand the reviewer a second copy of something they have
already dealt with; `content_json.sourceContentHash` remembers the machine's original hash so an
edited block is matched too. Only blocks the machine still owns (`reviewed_by IS NULL`) have their
status set by a run, so a re-run can never move an approved block back to `needs_review`.

**Nothing here creates taxonomy, and nothing here publishes.** Mapping chooses among *published*
sub-topics that already exist; where nothing fits it writes a proposed name onto a review task and
stops. Publication is a separate, human-initiated call, behind the gates in `quality-gates.ts`.

**A question becomes a question through Phase 3.** `ReviewService.publish` calls
`QuestionsAdminService.create`, `.publish` and `.setOfficialSolution` — the same service an admin
authoring by hand goes through — so per-type answer validation, the starting `difficulty_b` from the
active engine configuration, versioning and the audit rows all apply, and there is no second
question model to drift. Phase 7 stores only *proposals*, in `content_blocks.content_json`.

### The three boundaries, and what each does when it cannot run

| Boundary | Interface | Adapters that ship | When it cannot run |
| --- | --- | --- | --- |
| Object storage | `ObjectStorage` (`put`/`get`/`head`/`delete`) | `local` (filesystem), `memory` (tests) | `STORAGE_DRIVER=s3` throws **at boot**: an API that starts and then loses every upload is worse than one that refuses to start and says why |
| Queue | `JobQueue` (`process`/`enqueue`/`drain`) | `InProcessJobQueue` | BullMQ is not installable here (DECISIONS §D). The database holds the stage and the attempt count, so a job stranded by a restart is re-runnable through the same idempotent stages |
| OCR | `OcrProvider` (`recognise`) | `UnavailableOcrProvider` | It **refuses** rather than returning empty text, because empty text is indistinguishable from a blank page. The pipeline records the page, keeps its thin text, and opens a review task |

Object keys are built, never taken from the upload: `tenants/<tenant>/<kind>/<yyyy>/<mm>/<uuid><ext>`.
`assertSafeKey` rejects anything that is not exactly that shape — no traversal segment, no
backslash, no control character, NFC-normalised, bounded length — and every adapter validates with it
before touching anything, so a hostile filename has nothing to act on. The uploaded name is kept in
`content_assets.original_filename`, where it is only ever data.

### Embeddings

Publishing a theory block calls Phase 6's own indexing path (`ExplanationsService.reindexSubtopic`),
so ingested theory reaches semantic retrieval through the existing embedding abstraction rather than
a second one. It never fails the publication: where pgvector or an embedding provider is missing, the
block is published and findable by keyword, and the response says why the embedding did not happen.

## 10. Explanations, the AI boundary and RAG

### The AI boundary

```ts
interface AiProvider {
  readonly name: 'gemini' | 'claude'
  readonly explanationModel: string
  readonly embeddingModel: string | null      // Claude has none
  generateExplanation(prompt: ExplanationPrompt): Promise<AiExplanationResult>
  embed(texts: string[]): Promise<EmbeddingResult>
}
```

Everything above `src/ai/ai-provider.ts` — resolution, grounding, validation, visibility —
is written against that interface and names no vendor. Two rules the implementations hold to:
**nothing the model says is trusted** (correctness comes from the question's own answer key,
grounding from the retrieved notes), and **failures are typed** — `AiProviderError.kind` says
whether another provider could fix it, so the dispatcher falls back without parsing error
strings.

`AiService` decides who serves a request: no primary configured → `503 AI_NOT_CONFIGURED`,
nothing called; the primary; on a *retryable* failure the fallback, but only when named in
`AI_FALLBACK_PROVIDER` with its key present — a paid provider is never reached for by
inference; otherwise `503 AI_PROVIDER_UNAVAILABLE`, with the provider's own message kept out
of the response. API keys are read in `ai.module.ts` and nowhere else, and are handed only to
the provider instance.

### Resolution order

| Step | What happens |
| --- | --- |
| 1 | An **approved official solution**, if the course has one. No provider call, and it is never held for approval — a human wrote it. |
| 2 | Otherwise theory is **retrieved** (sub-topic, widening to topic then chapter) and an explanation generated that may use only those notes. |
| 3 | The result is **scored** for grounding against the notes it was given. |
| 4 | Below the band, the notes are dropped and a **general-knowledge** explanation is generated instead, labelled "Not from official notes — pending review" and sent for review. |

Two rules override all of it. An explanation whose own conclusion disagrees with the answer
key is **never served** — stored `rejected` with a review task, so the failure is auditable.
And a track configured for mandatory approval (Olympiads) holds every *generated* explanation
until a human passes it.

The student payload says only which of the four sources it came from. The tier, grounding
score, supporting blocks, retrieval trail, provider, model and the answer the model argued for
are on the row and on the admin route.

### Retrieval

Hard filter by sub-topic **in SQL** — the scope is a correctness rule, not a ranking hint,
because semantic similarity will happily return thermodynamics notes for a rotational-dynamics
question. Both halves of the hybrid search run per scope: pgvector cosine over
`block_embeddings` (cast to `vector(N)` so the partial HNSW index is used) and `ts_rank_cd`
over `content_blocks.search_tsv`, fused by `explanation.retrieval.vector_weight` with the
keyword score rescaled to carry the whole weight when a block has no embedding. While fewer
than `retrieval.min_chunks` clear the score floor the ladder widens along `rag.widen_order`,
**accumulating** rather than replacing — the narrowest notes are still the most relevant — and
records why at each step. `retrieval_scope` stores how far it actually reached.

Grounding bands: **≥ 0.75** notes-only · **0.50–0.75** mostly-notes · **below** general
knowledge plus a review task. The formula is in DECISIONS.md §B44; it measures the explanation,
not the retrieval.

### Caching and invalidation

One active explanation per `(question_id, question_version, option_key)`, with distractor
variants keyed by the option (migration 0011). Invalidation is **derived** — no cache-key
column to keep in step: the question version is part of the key; a grounding block edited since
`generated_at` supersedes it; a newer `engine_config` activation supersedes it; and a different
`PROMPT_VERSION` supersedes it, so a prompt fix cannot leave old output in circulation. A row
that failed validation is remembered so a broken question is not sent to the provider on every
request, and an explanation unpublished by student reports stays unpublished until a human
clears it (DECISIONS.md §B50).

### Reporting and review

`POST /v1/questions/{id}/report` opens a `student_report` review task; the database allows one
open report per student per question (`review_tasks_open_report_uq`, migration 0004), so a
second is a conflict rather than a way to inflate the count. At
`explanation.reports.unpublish_threshold` distinct reporters every active explanation for the
question becomes `flagged` — kept, never deleted — and each gets an `explanation_review` task.
Reviewers approve or reject through `POST /v1/admin/explanations/{id}/review`; approving is
what releases an explanation a mandatory-approval track was holding. Every transition writes an
audit row naming the actor.

## 11. Analytics, benchmarking, focus tracking

- Analytics derive from `attempts` (immutable) + `ability_scores` (projection):
  accuracy by sub-topic and difficulty, speed index, mastery from θ, 14-day trend,
  consistency, coverage, retention checks, time spent, weak areas, strengths.
- Benchmarks: nightly job writes `benchmark_snapshots` per sub-topic over a 90-day
  window — top-10 accuracy and median time, **published only when the qualifying student
  count meets the configured minimum** (a DB CHECK). No user ids, names or ranks are
  stored. Switchable off per tenant.
- Focus tracking accepts only the whitelisted event types (tab/app switches and duration,
  TTFI, answer changes, idle, breaks, session duration, explanation engagement). There is
  **no free-form payload column**, so keystrokes or anything else cannot be stored. No
  composite focus score. Disabled per tenant or per student opt-out.

## 11b. Learning contexts: how the platform stays general _(Phase 8)_

JEE, NEET and the Olympiads are *examples* of learning tracks, not the shape of the product. A Class 5
learner and a JEE learner go through the same code — the same selection rules, the same grading
weights, the same ladder, the same explanation path. That is a property worth stating precisely,
because it is the one thing Phase 8 had to establish and the one thing that is easy to lose later.

**The engine was already general.** The Phase 8 audit looked for exam-specific branches in
`src/adaptive/` and found none: no exam name, no year, no rank appears anywhere in the engine or in the
practice flow. So Phase 8 is metadata, enrolment and hardening — not a rewrite. Two things were
genuinely missing, and migration 0013 adds exactly those two.

### A track can say what it is

`tracks` gained seven nullable columns: `kind` (`school` · `competitive_exam` · `olympiad` · `other`),
`education_stage`, `grade_label`, `grade_ordinal`, `exam_family`, `curriculum`, `locale`. All nullable,
no defaults, no back-fill — so every track that existed before 0013 keeps working and stays
*uncategorised*, and `null` means "not stated" rather than any default. A frontend that reads a null
`kind` as "competitive exam" would reintroduce the assumption this removes.

`exam_family`, `curriculum` and `grade_label` are free text on purpose: inventing a controlled
vocabulary of boards, exams or curricula is precisely what the brief forbids. `kind` is the one closed
set, because a safety rule reads it.

Two things this metadata explicitly does **not** do:

* **`grade_ordinal` is not a difficulty.** It exists so Class 5 sorts before Class 6 without parsing a
  label. No grade-to-difficulty mapping is defined anywhere, because none is specified, and L1–L5 keeps
  its existing meaning. A test asserts that two tracks differing only by grade serve the same first
  question (DECISIONS.md B66).
* **There is no learner *type*.** A learner is a school learner, a competitive learner or a mixed
  learner *because of the tracks they are in*. It is derived, so it cannot contradict itself.

The one place the metadata carries authority is `kind = 'olympiad'`, which is now the Olympiad safety
check for mandatory explanation approval and for the L5 auto-approval block. It replaces matching
substrings against a track's *name*, which meant a rename silently switched a safety rule off
(DECISIONS.md B60).

### A learner can be in several tracks

`users.primary_track_id` is a single column, so "Class 10 Mathematics, JEE Foundation and Olympiad
Mathematics" could not be represented at all. `learner_tracks` is that relation, and it is **additive**:
`primary_track_id` keeps its meaning and is kept in step by every path that changes which track is
primary, in one transaction, so the two can never disagree. `learner_tracks_one_primary_uq` — a partial
unique index over the primary rows — makes "at most one primary" a database guarantee rather than an
application habit.

Enrolments are **materialised lazily, never back-filled** (DECISIONS.md B63), and an enrolment records
**intent, not access** (B64): practice is still authorised per sub-topic through the published
syllabus, so nothing reads `learner_tracks` to decide what a learner may do.

### Mastery is isolated per track, structurally

`ability_scores` is unique per `(tenant_id, user_id, subtopic_id)`, and a sub-topic belongs to exactly
one topic → chapter → subject → track. So a learner in three tracks **already** has three independent
sets of mastery, and no code path can merge them — not because a check forbids it, but because there is
no row two tracks could share. Phase 8 changed nothing here and added the test that keeps it true.

The corollary is worth stating: shared foundational content across tracks is **not** supported. The
same concept in two tracks is two sub-topic rows with independent mastery. That is explicit and
deterministic, and it is the trade-off for isolation being structural rather than enforced.

### What is deliberately absent

No `Program` abstraction above Track (the hierarchy already carries the meaning; a second one would be
a new concept for every existing query to ignore), no `isPremium`/`isPaid`/`hasSubscription` anywhere
(the brief forbids scattering them, and no payment or subscription feature exists), and no Class 1–12
content. The dev seed carries a **two-question** Class 5 fixture whose own description says "Not a
syllabus" (DECISIONS.md B67).

## 12. Security checklist

helmet headers · CORS allow-list from env · global `ValidationPipe` (whitelist,
forbidNonWhitelisted) · `@nestjs/throttler` (Redis store in production) with tighter
limits on auth routes **and on the two explanation endpoints that trigger AI generation (NFR-S4)** ·
parameterised queries only (Drizzle / `sql` template) · upload
MIME + magic-byte + size + page-count limits **and a bounded inflate, so a 200 KB PDF cannot expand to
200 MB of heap** · audit on all admin actions **and on a learner's own profile and enrolment changes** ·
secrets only from environment, validated at boot **and `sslmode` required in the database URL in
production, because `pg` defaults to cleartext without it** · no stack traces in production error
bodies · `/health/ready` reports *whether* the database is migrated, not how many migrations there are.

Two answer-key rules are worth naming separately, because both were tightened in Phase 8 and both are
about inference rather than disclosure:

* The attempt result no longer returns `expectedScore`. It looked harmless, but
  E = 1 / (1 + 10^((b − θ)/elo_scale)) inverts: a client that knows its own θ and the Elo scale can
  solve for the question's `difficulty_b`, which is a column the student projection deliberately
  withholds.
* An explanation is a worked answer, so reading one before attempting the question is an answer
  oracle. The attempt requirement is a floor that configuration cannot lower (DECISIONS.md B61).

## 13. Phase plan

| Phase | Scope |
| --- | --- |
| 1 ✅ | Scaffold, env validation, Docker Compose, full SQL schema, migration runner, dev seed, DB-level tests |
| 2 ✅ | Drizzle schema mirror, common layer, auth, users, tenants, RBAC, tenant isolation + tests |
| 3 ✅ | Syllabus tree, theory, question bank, student-safe projection, leakage tests |
| 4 ✅ | engine_config service + adaptive engine core + unit tests |
| 5 ✅ | Practice sessions, `/next`, idempotent attempts, session events, the rebuildable ability projection + tests |
| 6 ✅ | AI provider abstraction, embeddings, RAG, explanations, grounding and safety, question reports |
| 7 ✅ | Ingestion pipeline: upload, storage boundary, job stages, extraction, OCR interface, classification, mapping, question and solution extraction, near-duplicate detection, review, gates, publish |
| 8 ✅ | Generalisation to a learning platform (track learning contexts, multi-track learners), §6.4 expected-time calibration, security and performance hardening, the beta support harness |
| — | Analytics, benchmark snapshots, reports and nightly jobs were listed here before Phase 8 was re-scoped to generalisation. They remain unbuilt; `benchmark_snapshots` and `reports` exist as tables with no service behind them. |
| next | Not scoped here. DECISIONS.md §E lists what the requirements document still asks for that the code does not do — that list, not this table, is the honest backlog. |
