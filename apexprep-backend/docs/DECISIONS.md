# Decisions, ambiguities and open questions

The requirements document (`Adaptive-Practice-App-Requirements.docx`) was **not
available** when this was written. Every item below either follows the written prompt
or picks the safest option and says so. Anything the document settles differently
replaces the default here.

Legend: **[DEFAULT]** implemented this way unless you say otherwise ·
**[NEEDS YOU]** a product decision I won't make alone · **[PENDING DOC]** the value
must come from the requirements document.

## A. Supporting tables added beyond the required 25

| Table | Why it's needed |
| --- | --- |
| `refresh_tokens` | Rotating refresh tokens need server-side state for rotation and family revocation. `sessions` is reserved for practice sessions (it has `session_events`). |
| `user_tokens` | Hashed single-use email-verification (and later password-reset) tokens. |
| `question_secondary_subtopics` | "Secondary subtopics" is many-to-many; a join table keeps FK integrity (a `uuid[]` could not). |
| `question_assets` | Diagrams attached to a stem, option or solution, with FK integrity. |
| `session_items` | Records which question was **served**. Needed so an abandoned or unanswered question is never turned into an incorrect attempt, and so the attempt endpoint can check the question was actually served in that session. It cannot live in `session_events`, because focus tracking can be switched off. |
| `schema_migrations` | Migration runner bookkeeping. |

## B. Product ambiguities

- **B1 · Mock tests. [NEEDS YOU]** The frontend ships a Tests flow; the requirements
  (as given in the prompt) list no tests tables or APIs. Options: (a) add `tests`,
  `test_items` and test-mode sessions with marking schemes; (b) defer. **Default: defer.**
  Nothing is built for tests yet.
- **B2 · Percentiles and peer bands. [DEFAULT]** `peerBand` ("Top 5%") and
  `TestResult.percentile` rank a student against others. The requirement is anonymous
  benchmarks with no ranks and no leaderboard. **Default: the API returns `null` for
  these fields.** Only the anonymous top-10 benchmark (accuracy, median time) is exposed.
- **B3 · Is content shared across tenants? [DEFAULT]** **Default: all syllabus and
  question content is tenant-owned** (strongest isolation; platform content lives in the
  platform's own tenant). Trade-off: question calibration (`difficulty_b`) learns only
  from that tenant's students. Shared catalogues can be added later without breaking
  isolation.
- **B4 · What the `reports` table holds. [DEFAULT]** Two APIs use the word:
  `GET /me/reports` (student performance reports) and `POST /questions/{id}/report`
  (a student flagging a faulty question). **Default: `reports` = generated performance
  reports; question flags become `review_tasks` with `kind = 'student_report'`,** so
  they land in the admin review queue.
- **B5 · "Ask AI" free-form chat. [DEFAULT]** The frontend has an Ask AI box; the
  requirements API list has no such endpoint. **Default: `POST /v1/questions/{id}/ask`,**
  answered through the same grounded pipeline (official solution → RAG → general), only
  after the student has attempted the question, and rate-limited per user.
- **B6 · UI fields with no requirement.** `hints` → optional `questions.hints` (text
  array) **[DEFAULT]**; `positiveMarks/negativeMarks` → belong to a test marking scheme,
  not to a question, so they wait for B1 **[DEFAULT]**; `avgPeerTimeSec` → median
  `total_time_ms` from attempts once a minimum sample exists **[DEFAULT]**;
  `difficultyIndex` → not computed until defined **[PENDING DOC]**; subject `color` and
  chapter `weightage` → stored as display metadata **[DEFAULT]**.
- **B7 · Row-Level Security. [DEFAULT]** Isolation is enforced by JWT-only tenant
  context, tenant-scoped repositories and composite FKs. RLS policies are a hardening
  step for later, because they force every request into a transaction with `SET LOCAL`.
- **B8 · Who can disable focus tracking. [DEFAULT]** Both: a tenant-level switch
  (`tenants.focus_tracking_enabled`) and a per-student opt-out
  (`users.focus_tracking_opt_out`). Effective setting is snapshotted on each session.
- **B9 · Subjects shared across tracks.** The frontend lists Physics under both JEE and
  NEET as one subject. The requirements hierarchy is a strict tree. **[DEFAULT]** Strict
  tree: JEE Physics and NEET Physics are separate subjects; a question can link to
  another track's sub-topic as a *secondary* sub-topic.
- **B10 · Scoring S for multi-correct and matrix-match. [PENDING DOC]** The Elo update
  needs S ∈ [0,1]. Default until specified: S = 1 only for a fully correct response,
  else 0; `attempts.score` is stored as a number so partial credit can be switched on
  without a schema change.
- **B11 · Long-form / proof questions. [DEFAULT]** Stored, served and answered, but
  excluded from automatic θ/b updates until graded (`outcome = 'ungraded'`).
- **B12 · 30-day exclusion scope. [PENDING DOC]** Default: excludes questions *attempted*
  in the window, and also those *served and skipped*, so skipping can't be used to farm
  easy items. The `exclusion_includes_skipped` config key controls it.
- **B13 · Immutable attempts vs erasure requests. [DEFAULT]** Attempts can't be updated
  or deleted through normal SQL. Account erasure will be a separate, audited
  administrative procedure that runs under a privileged database role.
- **B14 · Exam dates. [DEFAULT]** `tracks.exam_date` (per tenant, editable) plus an
  optional per-student `users.target_exam_date` override; `daysToExam` is computed, never
  hard-coded.
- **B15 · Who may change engine parameters and create staff. [DEFAULT]** Tenant `ADMIN`s
  can read the engine configuration; changing it (`engine_config:manage`) and creating staff
  accounts (`staff:manage`) are `SUPER_ADMIN` powers. This is one line in
  `src/common/auth/permissions.ts` if tenants should manage their own engine settings.
- **B16 · Which organisation a sign-in belongs to. [DEFAULT]** Email addresses are unique per
  organisation, not globally, so register and login need to know the organisation. They use
  an optional `tenantSlug`, falling back to `DEFAULT_TENANT_SLUG` (so the current frontend,
  which sends only email and password, works unchanged in a single-organisation deployment).
  This only chooses whose user directory to check; after sign-in the tenant comes from the
  token plus a database lookup. Self-registration is **off by default** per organisation
  (migration 0008) so nobody can join an organisation by guessing its slug.
- **B17 · JWT implementation. [DEFAULT]** The build environment could not install packages,
  so access tokens use a minimal HS256 implementation on Node's `crypto` (fixed algorithm,
  exact header check, constant-time comparison, signature verified before the payload is
  read; unit-tested against `alg: none`, algorithm substitution and tampering). It sits
  behind `TokenService`, so replacing it with `jose` is a one-file change if you prefer a
  library.
- **B18 · Password rules. [DEFAULT]** 8–128 characters, not blank, not equal to the email
  (NIST SP 800-63B style: length over composition rules). **The frontend sign-up form
  currently accepts 6+ characters**; the API will answer 400 for 6–7 character passwords
  until the form is updated.
- **B19 · Where the refresh token lives. [DEFAULT]** Only in an HttpOnly, SameSite=Strict
  cookie scoped to `/v1/auth`; it is never in a JSON body unless `REFRESH_TOKEN_IN_BODY=true`
  (for future native clients). Cookie-borne refreshes from an origin outside `CORS_ORIGINS`
  are refused.
- **B20 · Email delivery. [DEFAULT: SMTP; provider still to choose]** All email (welcome,
  verification, password reset) goes through `MailService`, selected by `MAIL_PROVIDER`:
  `console` (development; logs that a message would be sent, with `token=` values redacted),
  `memory` (tests), `smtp` (nodemailer; production) or `none`. Production refuses console and
  memory, requires https email links, and requires STARTTLS unless `SMTP_SECURE=true`. Sending
  is best effort and off the request path: a mail outage never fails registration, and a failure
  is logged with its error code only. Any SMTP provider works (SES, Postmark, SendGrid, Resend,
  Mailgun, Google Workspace…); which one, and its SPF/DKIM setup, is still your decision. For
  local end-to-end tests, `docker compose --profile mail up -d mailpit` gives an SMTP catcher.
  The verification link points to `FRONTEND_URL/verify-email`, a page the frontend does not
  have yet; reset links point to `FRONTEND_URL` + `PASSWORD_RESET_PATH`, which it does.
- **B20a · Password reset. [DEFAULT]** `POST /v1/auth/forgot-password` always answers 202 with
  the same message (no account enumeration) and issues the link in the background. Tokens are
  32 random bytes, stored only as SHA-256 in `user_tokens` (purpose `password_reset`), valid for
  `PASSWORD_RESET_TTL_MINUTES` (default 30), single-use, and a new request deletes older unused
  ones. Rate limits: the per-IP auth bucket plus one link per account per minute.
  `POST /v1/auth/reset-password` applies the normal password policy, hashes with argon2id,
  revokes every refresh token (`password_change`) and bumps `token_version`, so all existing
  sessions end. No new table: `user_tokens` already had the purpose, hash, expiry and indexes.

- **B21 · Authoring theory blocks by hand. [DEFAULT]** Theory is `content_blocks` rows with
  `kind = 'theory'`. An admin can author `heading, paragraph, formula, callout, list, table,
  example` blocks; `figure` needs an uploaded image, so it waits for content ingestion
  (Phase 7). A block is saved unpublished (`approved`) unless `publish: true`, and students
  only ever see `published` blocks of a visible sub-topic. List and table structure is kept
  in `content_json` and mirrored into `raw_text` so full-text search still works.
- **B22 · `readMinutes` for a theory page. [DEFAULT]** The frontend shows a reading time but
  no requirement defines it: word count ÷ **200 words per minute**, rounded up, minimum 1
  for any non-empty text (`src/syllabus/theory-text.ts`). One constant to change.
- **B23 · A question's type is immutable. [DEFAULT]** `PATCH /admin/questions/{id}` does not
  accept `type`: attempts record the version they were graded against, and changing the type
  would change the meaning of every stored response. Create a new question instead.
- **B24 · `difficulty_b` when the difficulty label changes. [DEFAULT · PENDING DOC]** If the
  engine has never calibrated the question (`calibration_n = 0`), `difficulty_b` is reset to
  the new level's `initial_b_by_level`. If it has, the learned value is kept, because
  attempts are the better evidence. The document may define a different relationship between
  L1-L5 and the Elo scale.
- **B25 · Question deletion and retirement. [DEFAULT]** A published question cannot be
  deleted; it must be retired first (kept for attempt history, never served again). Deletes
  are soft everywhere in the syllabus and question bank. A syllabus node cannot be deleted
  while it still has live children, questions or content blocks (409 `NODE_NOT_EMPTY`), and
  nodes cannot be moved to a different parent — a question can be moved between sub-topics.
- **B26 · Where question counts come from. [DEFAULT]** `questionCount` in the syllabus tree
  counts **published** questions by **primary** sub-topic, and rolls up. Secondary sub-topics
  are not counted, so one question is never counted twice in a track.
- **B27 · Reporting a faulty question. [DEFAULT]** `POST /v1/questions/{id}/report` needs the
  question to have been served to that student (a `session_items` row), which only exists
  once the practice API is built, so the endpoint ships with practice and explanations
  (Phase 6) rather than with the question bank. The table and rules are already in place
  (`review_tasks.kind = 'student_report'`, one open report per student per question).

- **B28 · θ and the level are both tracked. [DEFAULT]** The **ladder** (2 consecutive
  correct within 1.25× expected time, or 3 of 4 — and 2 consecutive incorrect, or 3 of 5)
  maintains the working level; `level_bands` say which band **θ** currently sits in.
  Selection aims at `b* = f(θ)`, so when the two disagree only reporting is affected, never
  what is served. The engine returns both (`level`, `bandLevel`).

- **B29 · Probable guesses. [SETTLED BY REQUIREMENTS]** A probable guess is an answer that
  is **incorrect and given in under 25% of the question's expected time**. (An earlier
  default flagged any fast answer; that is replaced.) A flagged attempt is always **stored**
  but is excluded from the ability update and from the level ladder, and **three flagged
  guesses pause the session**. Whether it should also freeze the question's difficulty is
  *not* stated: `probable_guess.question_update` is set to `skip` and listed as provisional.

- **B30 · Cold start and parent-topic seeding. [SETTLED BY REQUIREMENTS]** A student with no
  history starts at **L2**. Where they have already practised other sub-topics of the same
  topic, θ is **seeded from that parent-topic ability** (the mean of the sibling sub-topics)
  and the starting level follows from the band θ lands in. With no parent-topic history, θ
  is the middle of the L2 band.

- **B31 · Placement. [DEFAULT · PENDING DOC]** The first `placement.question_count`
  questions (8) are marked `selection_reason = 'placement'` and update θ by the same Elo
  rule, so the level settles from the student's own answers. A distinct placement ladder,
  if the document defines one, replaces only `selection.ts`.
- **B32 · Platform administrators and tenant-scoped actor columns. [DEFAULT]**
  `engine_config.created_by / activated_by / deactivated_by` are tenant-scoped foreign keys,
  so a SUPER_ADMIN acting on another organisation cannot be named in the row. The column is
  left NULL (the database records the event as SYSTEM) and the service writes an extra audit
  row — `engine_config.platform_created` / `.platform_activated` — naming the real actor and
  their organisation.
- **B33 · Invalid stored parameters. [DEFAULT]** A configuration version that does not
  satisfy the schema can be read (the API shows `paramsValid: false` and lists the missing
  keys) but cannot be activated, and the engine refuses to run on it
  (`ENGINE_CONFIG_INVALID`). Nothing is defaulted in its place.

### Phase 5: the practice flow

- **B34 · Repeating `GET /next`. [DEFAULT]** The requirement is that a session never has two
  questions outstanding. **Default: `/next` is idempotent** — while a question is unanswered
  it returns that same question, so a refresh, a retry or a second tab cannot burn through the
  bank. Moving on is explicit (`?skip=true`), and the skipped question is recorded as skipped
  so the exclusion rules can see it. The alternative (serve a new question each call) would
  let a student skip anything they did not like, invisibly.
- **B35 · Starting a session when one is already open. [DEFAULT]** `POST /practice/sessions`
  returns the open session with `resumed: true` rather than creating a second one or failing.
  The database already forbids two active sessions per student × sub-topic, so the choice is
  between resuming and an error; resuming is what a reopened app needs.
- **B36 · Idempotency keys are required, not optional. [DEFAULT]** `POST /practice/attempts`
  rejects a submission with no `Idempotency-Key` (400, naming the header). A retried answer on
  a flaky connection must not be able to grade twice, and a key the client forgot to send is
  the one case where that could happen. A replayed key returns the stored attempt with
  `replayed: true`; the same question under a *different* key is `409 INVALID_STATE`, because
  the served item has already been answered.
- **B37 · The pause after three flagged guesses is derived, not stored. [DEFAULT]** It is
  `count(*)` over the session's attempts where `probable_guess`, so it cannot drift from the
  attempts and no column can be left stale. A paused session answers
  `409 SESSION_PAUSED` from `/next` and from `/attempts`; the student starts a new session
  when they are ready. Nothing unpauses an existing one — that would need a stated rule.
- **B38 · Which pool a widened selection reports. [DEFAULT]** When a sub-topic has fewer than
  `content_gap.min_eligible` questions, the service re-runs selection over the parent topic's
  sub-topics and uses the wider pool **only if it yields more eligible questions**. The served
  item still records the session's own sub-topic, and the response carries
  `contentGap: { eligibleCount, minEligible, widenedToParentTopic }` so the frontend can say
  why the question came from next door. One `content_gap` review task is opened per sub-topic
  (a second call is a no-op), so a thin sub-topic does not flood the review queue.
- **B39 · Inactivity decay is applied once per absence. [DEFAULT]** Decay is computed from the
  last *attempt*, and it is evaluated whenever a session opens or `/next` runs — so without a
  guard the same absence would be charged repeatedly. `last_decay_applied_at` is the guard:
  once it is later than `last_attempt_at`, no further decay is applied until the student
  answers another question. A student away for 40 days therefore loses 30 θ points once, not
  once per request. The trade-off: opening a session without answering anything and returning
  months later adds no further decay. Since everything about decay except the 21-day trigger
  is **NOT SPECIFIED** (see §C), this is the conservative reading — a student is never charged
  twice for one absence.
- **B40 · Migration 0009 (`ability_scores.ladder_reset_at`). [REQUIRED BY THE RULES]** The
  ladder rules are counters ("2 in a row", "3 of the last 5"), so the evidence a rule consumed
  must not fire it again at the new level — three quick correct answers would otherwise climb
  two levels. Everything else in the window is derived from `attempts`; where the current
  level started is the one fact that cannot be. The column is written from a SQL expression
  reading the attempt's own `created_at`, because a `timestamptz` keeps microseconds and a
  JavaScript `Date` does not: a round-tripped boundary lands up to a millisecond early and
  lets the promoting attempt back into its own window.
- **B41 · Migration 0010 (`attempts.calibration_n_at_attempt`,
  `expected_time_seconds_at_attempt`). [REQUIRED BY THE RULES]** The requirement that
  `ability_scores` be rebuildable from the immutable attempts could not be met without them.
  `attempts` already snapshotted `theta_before`, `difficulty_b_at_attempt`, `expected_score`
  and the config version, but K_s and K_q depend on `questions.calibration_n`, and the
  probable-guess and promotion-speed rules depend on `questions.expected_time_seconds` — both
  mutable columns that have moved on by the time anyone replays. Without the snapshots a
  replay could reproduce the whole θ trajectory *except its final step*, which is exactly the
  value the projection holds. Both columns are nullable: `attempts` is append-only, so rows
  written before the migration cannot be backfilled, and a replay reports them
  (`exact: false`) instead of guessing.
- **B42 · Long-form answers are stored ungraded. [DEFAULT]** `outcome: 'ungraded'`,
  `score: null`, and the engine moves nothing — no θ, no question difficulty, no ladder entry.
  Marking them needs either a human or the Phase 6 AI, neither of which exists yet, and a
  guessed score would corrupt the calibration of every other question the student sees.
- **B43 · No partial credit yet. [DEFAULT]** A multi-correct or matrix question scores 1 only
  when the whole answer is right, 0 otherwise. The schema allows `outcome: 'partial'` with
  `0 < S < 1` for when a marking scheme is specified; nothing produces it today.

### Phase 6: explanations and RAG

- **B44 · How the grounding score is computed. [DEFAULT]** The requirements give the *bands*
  (≥ 0.75 notes-only, 0.50–0.75 mostly-notes, below that general knowledge plus a review task)
  but not the formula. **Default:** the fraction of the explanation's own content terms that
  appear in the retrieved notes, counting only terms the *question* did not already supply:

  > grounding = (content terms of the explanation found in the notes) ÷ (content terms of the
  > explanation that are not already in the question)

  Three properties this was chosen for. It measures the **output**, not the retrieval, so a
  confident retrieval the model then ignored scores badly. It **excludes the question's own
  terms**, so restating the stem is not evidence. And it **ignores the model's own citations**,
  which are kept as metadata only — a model asserting that it used the notes is not evidence
  that it did. It is pure and deterministic, so a stored score can be re-derived and audited.
- **B45 · Visibility is derived, not stored. [DEFAULT]** Whether a student may see an
  explanation follows from its tier, its status, its grounding and its track — it is computed on
  every read (`src/explanations/visibility.ts`) rather than kept in a column. That is why Phase 6
  adds no `pending_review` status: a stored flag would have to be kept in step with the approval
  rules by hand, and a stale one is the difference between a student seeing an unapproved
  Olympiad explanation and not. It also means raising `notes_only_min` immediately re-labels
  what is already stored.
- **B46 · Which statuses mean what. [DEFAULT]** The existing enum carries all of it, so no
  migration widened it: `active` = valid (and visible unless a rule holds it), `flagged` =
  unpublished after student reports, `rejected` = failed automated validation or a reviewer said
  no, `superseded` = a newer explanation exists. Nothing is ever deleted.
- **B47 · Identifying an Olympiad track. [DEFAULT · NEEDS YOU]** The requirements mandate human
  approval for Olympiad explanations, and nothing in the schema marks a track as an Olympiad.
  Options were: (a) a new `tracks.exam_kind` column; (b) match the track slug. **Default: (b)** —
  `explanation.approval.mandatory_track_slug_patterns`, seeded with `["olympiad"]` and matched
  case-insensitively as a substring, so which tracks are Olympiads is configuration rather than a
  rule invented in code and no migration was needed. If you would rather it were a column on
  `tracks`, that is a one-line migration and a one-line change here.
- **B48 · What "student eligibility" means. [DEFAULT]** §9 requires eligibility to be verified
  without defining it. **Default: a student must have submitted an attempt on the question
  first** (`explanation.require_attempt`, on in the seed). A worked solution *is* the answer, so
  without this the endpoint is an answer oracle for unattempted questions and would break the
  standing rule that the correct answer is never exposed. The refusal is a 403 naming the reason.
- **B49 · Which distractor variant a student gets. [DEFAULT]** From their own recorded attempt —
  the most recent incorrect single-option answer — never from a query parameter, which a student
  could use to enumerate the options until one came back as "why this is wrong". Admins may name
  an option explicitly on the review route, and it is validated against the question's options.
- **B50 · An unpublished explanation stays unpublished. [DEFAULT]** After the report threshold,
  a `flagged` explanation is terminal until a human clears it, *even if* the theory or the prompt
  changes afterwards. Regenerating would silently republish what three students reported as
  wrong, with nobody having looked, and a review task is already open. A `rejected` one (failed
  automated validation) *is* retried once its inputs change, since that is what would fix it.
- **B51 · One chunk per theory block, not a chunk table. [DEFAULT]** The requirements ask for
  500–800-token chunks. The unit the schema embeds is the published `content_blocks` row
  (`block_embeddings.block_id` is unique per block and model), and most authored blocks are
  already inside that range, so a block is a chunk: a block over the ceiling is split on
  paragraph then sentence boundaries, and a run of very short blocks is merged. Chunk-level
  embeddings would need a `theory_chunks` table and a change to `block_embeddings`; grounding is
  recorded per *block* (`grounding_block_ids`), which is what a reviewer needs to check a
  citation, so nothing was added speculatively. **Deviation:** a split block's pieces share one
  embedding, so semantic ranking is per block while the prompt receives chunks.
- **B52 · Keyword retrieval ORs the question's terms. [DEFAULT]** `plainto_tsquery` and
  `websearch_to_tsquery` both AND them, which requires a note to contain *every* content word of
  the question — "ring", "find", "final" and all — so a perfectly relevant block matches nothing.
  The terms are therefore OR-ed and `ts_rank_cd` decides the order. Without this the keyword half
  of the hybrid search never fires.
- **B53 · `retrieval_scope` records how far retrieval *reached*, not how far it looked.** With
  two blocks in a sub-topic and a minimum of three, the ladder walks out to the chapter looking
  for a third and finds nothing; recording `chapter` there would say the explanation rested on
  chapter-wide notes when every chunk it used was the sub-topic's own. The full trail of what was
  tried is kept in the diagnostics.
- **B54 · No AI provider configured is a 503, not a silent skip. [DEFAULT]** With
  `AI_PROVIDER=none` and no official solution, the endpoint answers
  `503 AI_NOT_CONFIGURED` and stores nothing. A fallback provider is called **only** when named
  in `AI_FALLBACK_PROVIDER` with its key present, and only for a failure another provider could
  fix (network, timeout, 5xx, 429, rejected key, unparseable reply) — never for a bad request or
  a safety refusal. A paid provider is never reached for by inference.
- **B55 · Semantic retrieval degrades to keywords when pgvector is absent. [DEFAULT]** The
  extension is optional in this codebase already (migration 0007 is skippable), and Claude cannot
  embed at all. When either is missing, retrieval runs on its keyword half and the explanation's
  diagnostics record `semanticSkippedBecause`, so a degraded search is reported rather than
  hidden. Indexing is a separate admin action (`POST /v1/admin/subtopics/{id}/theory-embeddings`)
  that refuses outright rather than half-indexing.

### Phase 7: content ingestion

- **B52 · The stage names are mapped, not migrated. [DEFAULT]** The requirements list the job
  stages as uploaded → validating → extracting → OCR → classifying → mapping → extracting
  questions → matching solutions → embedding → ready_for_review → completed/failed.
  `ingestion_jobs.status` was fixed by migration 0003 with fourteen values that say the same things
  in different words. **Default:** `STAGES` in `ingestion.pipeline.ts` maps the requirement's names
  onto the statuses the database already has (`ready_for_review` → `awaiting_review`, and so on) and
  carries the progress percentage. Renaming the enum would have been a migration that changed
  nothing a caller can observe.
- **B53 · One file per upload, as the raw request body. [DEFAULT]** No multipart parser is
  installable here (§D), and a single-file upload does not need one: `POST
  /v1/admin/ingestion/assets` takes `Content-Type: application/pdf` with the PDF as the body, the
  hints as query parameters, and the original name from `X-Filename` or `Content-Disposition`. The
  byte limit is enforced **while reading** (`src/common/http/raw-body.ts`), so an oversized upload is
  refused before it is all in memory. If you want multipart, it is a parser plus a decorator; nothing
  above the controller changes.
- **B54 · An ingested question always needs a person, because of the expected time.
  [CONFIRMED BY §6.4]** `questions.expected_time_seconds` is NOT NULL and required by Phase 3's
  authoring DTO, and **nothing in a printed question states it**. Options were: (a) invent a value;
  (b) add a per-difficulty default to `engine_config`; (c) refuse to publish until a reviewer says.
  **Chosen: (c)** — the `expected_time` quality gate. (a) was out because the requirements forbid
  inventing values, and this value is not inert: the probable-guess rule and the promotion-speed rule
  both read it, so a guess would bend the engine's judgement of every student who answers the
  question. The consequence is worth stating plainly: **auto-approval reaches theory blocks only; a
  question block is always held for a person.**
  **Phase 8 re-files this from [DEFAULT] to [CONFIRMED].** §6.4 of the requirements document states
  it outright: `expected_time_seconds` is "admin-set at first, replaced by observed median once
  `calibration_n` >= 30". Admin-set at first *is* (c), so the gate stays exactly as it was; what was
  missing is the second half, which Phase 8 implements as B62. Option (b) is now positively ruled
  out rather than merely unchosen — a per-difficulty default would be the invented first value the
  document says an admin supplies.
- **B55 · `content_gap` keeps its Phase 4 meaning. [DEFAULT]** A block that no sub-topic fits is not
  a `content_gap` task: the schema requires `subtopic_id` on that kind, because it means "this
  sub-topic is short of questions". An unmapped block raises a `theory_review` or `question_review`
  task carrying `suggestion.unmapped` and the proposed name instead.
- **B56 · Difficulty is read, never proposed by a model. [DEFAULT]** Where the source prints
  "Difficulty: hard" or "Level: L4", it is kept verbatim as `sourceDifficulty` and mapped to L1–L5.
  Where it prints nothing, `difficultyLabel` is **null** and the `difficulty` gate blocks publication
  until a reviewer sets it. No model proposes a difficulty, so the requirement's "mark it as proposed
  and require review when confidence is insufficient" has nothing to mark: there is no guessed
  difficulty in the system. The separator in the difficulty pattern is required, so prose like "with
  no stated difficulty at all" cannot be read as a level.
- **B57 · Near-duplicate detection uses trigrams, not vectors. [DEFAULT]** The requirements ask for
  the existing embedding infrastructure and the existing threshold. `near_duplicate.trigram_similarity`
  is the existing threshold (Phase 4), `pg_trgm` is installed and `similarity()` runs for real, while
  pgvector is not available here (§D). **Default:** compare stems with `similarity()` at the
  configured threshold, which is a real check that runs today, and leave semantic duplicate detection
  to the same retrieval layer once pgvector is available. Nothing is ever deleted either way: a hit
  opens a `duplicate_candidate` task naming the existing question.
- **B58 · Auto-approval is a *status*, not a publication. [DEFAULT]** An auto-approved block starts
  at `approved` with `reviewed_by` empty; it is not published. Publication is always an explicit call
  that re-runs the gates. So the auto-approval rules decide who has to look, never what may reach a
  student.
- **B59 · A re-run does not duplicate what a reviewer has fixed. [DEFAULT]** `replaceMachineBlocks`
  deletes only blocks the machine still owns, which is what protects a reviewer's work — but it would
  then re-insert the machine's version of a block a person had already approved. It now skips any
  incoming block whose content hash a surviving block already carries, and `content_json.sourceContentHash`
  remembers the pre-edit hash so an edited block is matched too. A run also sets `status` only on
  blocks with `reviewed_by IS NULL`, so a re-run can never move an approved block back to review.

### Phase 8: a general learning platform

- **B60 · `tracks.kind = 'olympiad'` is the Olympiad safety check; the slug patterns are a fallback.**
  Two requirements single out Olympiad content: generated explanations need a human before a student
  sees them (FR-9.4, "Olympiad tracks SHOULD default to mandatory approval"), and L5 Olympiad content
  is never auto-approved. Phases 6 and 7 had nothing in the schema to ask, so both matched configured
  substrings against the track **slug** (the old B47), which made a safety rule depend on a name:
  renaming `maths-olympiad` to `maths-imo` switched off human review and nothing failed.
  Migration 0013 adds `tracks.kind`, and `isOlympiadTrack` (`src/common/learning/track-identity.ts`)
  now answers the question. `kind = 'olympiad'` is sufficient on its own and independent of any name,
  which is what makes it the actual check — with the slug patterns emptied, `kind` is the whole rule.
  The patterns are **kept as a fallback**, deliberately, for two cases: `kind` is NULL on every track
  that existed before 0013 (0013 back-fills nothing), so `kind` alone would have *removed* protection
  from existing Olympiad tracks the moment the migration ran — a safety regression shipped by a schema
  change; and a track whose slug says Olympiad while its `kind` says otherwise is a contradiction that
  is resolved toward the reviewer, because over-triggering costs an admin a click and
  under-triggering is the harm the rule exists to prevent. The service had a *second* copy of this
  rule; Phase 8 deleted it, because two copies of a safety rule are two rules that can disagree.

- **B61 · `explanation.require_attempt` is a floor, not a preference. [SAFETY]** An explanation names
  and works through the correct answer, so serving one for an unattempted question turns
  `GET /v1/questions/:id/explanation` into an answer oracle for the whole bank — and the engine would
  then be measuring nothing. A stored `false` is therefore **rejected** by
  `parseExplanationParams`, not honoured and not silently ignored: silently ignoring it would leave an
  admin looking at `false` in the configuration and gated explanations in the product with no way to
  tell which was true. Rejecting it fails the explanation slice only (the slices are independent), so
  an unsafe value takes out the explanation endpoints and nothing else. Separately, the eligibility
  check in `explanations.service.ts` **no longer consults the flag at all** — a conditional gate is
  one falsy value away from being open. The key stays because it is where the rule is written down and
  where a stricter successor (a minimum time on the question, say) belongs. It is listed in
  `safety_floor_keys` in the seed. Three independent mechanisms now hold it: the immutability of an
  activated `engine_config` version, the parse rejection, and the unconditional check.

- **B62 · The expected-time median excludes probable guesses, and is bounded by the admin's own
  range. [DEFAULT]** §6.4 states *when* observation replaces the admin's estimate
  (`calibration_n >= 30`) and *which statistic* (the median), but not **which attempts count**.
  Options were: (a) every attempt; (b) exclude probable guesses; (c) a recent window only.
  **Default: (b).** A probable guess is by definition answered in a small fraction of the expected
  time, so counting guesses pulls the median down, which shortens the guess threshold, which flags
  fewer guesses — a feedback loop with no fixed point worth landing on; and the quantity being
  estimated is how long the question takes to *answer*, which a guess never measures. (c) is out
  because no window is specified and one would be an invented value. Every other outcome counts,
  including `ungraded`: a long-form answer awaiting marking is still a learner who spent that long.
  A *skip* records no attempt row at all, so there is nothing to exclude.
  Two bounds are applied, and they are not tuning knobs: `min_seconds`/`max_seconds` mirror the
  `questions_expected_time_range` CHECK (migration 0004), so calibration can never store a value an
  admin could not have typed, and a pathological cohort cannot drive a question's expected time to
  zero and make every later answer look like a guess.
  The threshold is tested against `questions.calibration_n`, the column §6.4 names — not against the
  size of the median's own sample, which is smaller when guesses are excluded. That is the intended
  reading: the requirement says when to start trusting observation, the exclusion says which
  observations are of the thing being measured.
  Two properties make this safe to run inside the attempt transaction, and both are asserted by
  tests: it does **not** bump `questions.version` (`app_questions_bump_version()` fires only on the
  columns that change what the question asks, so cached explanations survive — otherwise the 30th
  attempt on a popular question would be an AI bill), and every attempt snapshots
  `expected_time_seconds_at_attempt` (migration 0010), so an attempt already recorded is replayed
  against the value in force when it was answered, never against the value it caused.
  One implementation note worth keeping: the median is cast to `numeric` before rounding.
  `percentile_cont` returns double precision, and `round()` on a float rounds half to even, so a
  median of exactly 114.5 s would have stored 114 while 115.5 stored 116.

- **B63 · Enrolments are materialised lazily; nothing is back-filled. [DEFAULT]** `learner_tracks`
  replaces nothing: `users.primary_track_id` keeps its meaning and is kept in step, because it is read
  by existing code and returned by the profile endpoint. Migration 0013 creates **no** enrolment rows.
  Options were: (a) back-fill one row per learner with a primary track; (b) materialise on first use.
  **Default: (b).** (a) writes a guess into every learner's data and touches every row of `users` in a
  migration that would have to be undone by hand if the guess were wrong. `ensure()` converts a
  learner's existing `primary_track_id` into the enrolment row it always implied — once, idempotently,
  inside the caller's transaction, and only for a learner who actually uses the feature. A learner who
  never does behaves exactly as they did before. The consequence is a write during a `GET`, which is
  acceptable because it converges after one call and is invisible to the caller.

- **B64 · An enrolment records intent, not access. [DEFAULT]** Practice is authorised per sub-topic
  through the published syllabus, exactly as before. Making enrolment a gate would change who may
  practise what — not a Phase 8 requirement — and would lock out every learner with no enrolment row,
  which after B63 is every existing learner. Nothing reads `learner_tracks` to decide what a learner
  may do.

- **B65 · Leaving a track promotes nothing. [DEFAULT]** A learner who leaves their primary track is
  left with **no** primary track rather than having the next one chosen for them: which track matters
  most is theirs to say, and no rule for choosing is specified. The row is kept with `status = 'left'`
  and `left_at`, so history survives and re-enrolling returns to the same row instead of starting a
  second one. `PATCH` with `isPrimary: false` is refused rather than accepted as a no-op — there is no
  "not primary" state to ask for.

- **B66 · `grade_ordinal` orders tracks and nothing else. [DEFAULT]** It exists so Class 5 sorts
  before Class 6 without parsing a label. **No grade-to-difficulty mapping is defined anywhere,
  because none is specified**, and L1–L5 keeps exactly its existing meaning. A test asserts that two
  tracks differing only by grade serve the same first question. The CHECK
  `tracks_grade_needs_school_kind` keeps a grade on a school track, and the service validates the
  same rule first so the admin gets the field name rather than "the request violates a data rule".

- **B67 · The Class 5 fixture is a fixture, and says so. [DEFAULT]** `002_dev_learning_contexts.sql`
  seeds one school track with **two** questions and two theory blocks. It exists to answer one
  question — does a Class 5 learner work end to end through the same code as a JEE learner? — and two
  questions answer it. Writing a Class 1–12 syllabus here would produce thousands of rows of invented
  schoolwork that looks authoritative, that no teacher has checked, and that a reader could mistake
  for the product's content. The brief forbids it; real content arrives through the Phase 7 ingestion
  pipeline from documents a person uploads and reviews. The fixture's own description says "Not a
  syllabus".

- **B68 · Adding a required engine parameter is a deployment step, not a migration. [OPERATIONAL]**
  The engine has no defaults, so adding a required key breaks every database whose active
  configuration predates it: practice returns 422 `ENGINE_CONFIG_INVALID` naming the missing key.
  This was **observed live** during Phase 8 verification, not predicted. Options were: (a) give the
  key a default; (b) update configurations in a migration; (c) an explicit operator step.
  **Chosen: (c)** — `npm run engine:upgrade`, dry-run by default. (a) is the invented value the whole
  design refuses. (b) cannot work as an edit: an activated `engine_config` version is immutable by
  trigger (AP001), so a migration would have to *activate a new version* for every tenant — changing
  an organisation's live configuration behind its back, and deactivating whatever version its admin
  had chosen. The script adds only the missing block, copies every existing value across untouched,
  validates the result before storing it, refuses a tenant whose configuration would still be invalid,
  and skips one that already has the key. `attempts.engine_config_id` still points at the version each
  past attempt was graded under, so replay is unaffected.

## C. Engine parameters

All live in `engine_config.params`, validated by `src/adaptive/engine-params.ts`
(versioned, immutable, audited by the database). **The schema has no defaults**: a version
missing a key is rejected with that key named, so no value below is ever invented by code.

> **Provenance.** `Adaptive-Practice-App-Requirements.docx` **arrived during Phase 8** and is now the
> authoritative source. Every row marked *stated* below was checked against it: all eight §8.6
> tunables match the seeded configuration exactly, and no stated value needed changing. The rows
> marked **NOT SPECIFIED** are the only ones still carrying a chosen value, and they are listed in the
> seed under `provisional_keys`.
>
> Phase 8 added one row from the document — `expected_time` — and re-filed B54 accordingly (§6.4
> states the median rule the earlier note had to leave open). Four requirements in the document are
> **not implemented**, and one is implemented differently; all five are listed under
> **E. Outstanding against the requirements document** at the end of this file, so the gap between the
> document and the code is written down rather than implied.
>
> A separate list, `safety_floor_keys`, marks keys that are **not tunable**: a configuration that
> weakens one is rejected rather than honoured. Today it holds `explanation.require_attempt` (B61).

| Key | Value | Source |
| --- | --- | --- |
| `elo_scale` | 400 | stated |
| `k_student.initial` / `.initial_attempts` / `.steady` | 32 / 20 / 16 | stated (K_s = 32 for the first 20 attempts, then 16) |
| `k_student.low_calibration_threshold` / `.low_calibration_factor` | 10 / 0.5 | stated (calibration_n < 10 → half K) |
| `k_question.uncalibrated` / `.calibrated_after` / `.steady` | 24 / 50 / 8 | stated (K_q = 24 while calibration_n < 50, then 8) |
| `cold_start.level` | 2 | stated (L2 cold start) |
| `cold_start.seed_from_parent_topic` | true | stated (parent-topic θ seeding) |
| `target_success` | 0.72 | stated |
| `promotion.consecutive_correct` / `.within_expected_time_factor` | 2 / 1.25 | stated |
| `promotion.window` / `.correct_in_window` | 4 / 3 | stated (3 of 4 correct) |
| `demotion.consecutive_incorrect` | 2 | stated |
| `demotion.window` / `.incorrect_in_window` | 5 / 3 | stated (3 of 5 incorrect) |
| `l1_protection.block_demotion` | true | stated (no demotion below L1) |
| `l5_ceiling.block_promotion` | true | implied by a five-level ladder |
| `probable_guess.requires_incorrect` / `.max_time_fraction_of_expected` | true / 0.25 | stated (incorrect **and** under 25% of expected time) |
| `probable_guess.theta_update` / `.counts_towards_level` | skip / false | stated (excluded from the ability update) |
| `probable_guess.pause_session_after` | 3 | stated (3 flagged guesses pause the session) |
| `expected_time.recalibrate_after_attempts` | 30 | stated (§6.4: replaced by observed median once `calibration_n` >= 30) |
| `expected_time.exclude_probable_guesses` | true | **NOT SPECIFIED** — §6.4 states the statistic and the threshold, not which attempts count (B62) |
| `expected_time.min_seconds` / `.max_seconds` | 5 / 7200 | not a tunable: mirrors the `questions_expected_time_range` CHECK (migration 0004) |
| `probe.every_n` / `.levels_above_target` | 5 / 0.5 | stated (every 5th question, half a level above target) |
| `probe.updates_theta` / `.counts_towards_demotion` | true / false | stated (affects θ, not the ladder demotion counters) |
| `probe.counts_towards_promotion` | true | follows from the above: only demotion counters are excluded |
| `inactivity_decay.after_days` | 21 | stated |
| `exclusion_days` | 30 | stated |
| `content_gap.min_eligible` / `.widen_to_topic` / `.open_review_task` | 5 / true / true | stated (under 5 eligible → widen to parent topic + content-gap alert) |
| `placement.enabled` / `.question_count` | true / 8 | from the original build prompt (8-question placement) |
| `benchmark.window_days` / `.top_k` | 90 / 10 | from the original build prompt |
| `level_bands` | L1 <900, L2 900-1100, L3 1100-1300, L4 1300-1500, L5 ≥1500 | **NOT SPECIFIED** — the θ scale the bands sit on was never given |
| `initial_b_by_level` | 800 / 1000 / 1200 / 1400 / 1600 | **NOT SPECIFIED** — starting difficulty per level was never given |
| `l1_protection.theta_floor`, `l5_ceiling.theta_cap` | null, null | **NOT SPECIFIED** — level guards are stated, θ guards are not, so neither is applied |
| `inactivity_decay.per_period_days` | 7 | **NOT SPECIFIED** — only the 21-day trigger is stated |
| `inactivity_decay.theta_points_per_period` | 10 | **NOT SPECIFIED** — how much θ decays is not stated |
| `inactivity_decay.max_total_points` | 150 | **NOT SPECIFIED** |
| `inactivity_decay.floor_theta` | null | **NOT SPECIFIED** — no decay floor is stated, so none is applied |
| `near_duplicate.trigram_similarity` | 0.85 | **NOT SPECIFIED** — excluding near-duplicates is stated, the similarity threshold is not |
| `near_duplicate.exclude_days` | 30 | **NOT SPECIFIED** — how long a near-duplicate stays excluded is not stated |
| `probable_guess.question_update` | skip | **NOT SPECIFIED** — only the *ability* update is stated as excluded |
| `probe.updates_question_b` | true | **NOT SPECIFIED** — a probe's effect on the question's own calibration is not stated |
| `exclusion_includes_skipped` | true | **NOT SPECIFIED** — see B12 |
| `benchmark.min_qualifying_students` | 30 | **NOT SPECIFIED** |
| `rag.top_k` | 5 | **NOT SPECIFIED** (used from Phase 6) |
| `rag.widen_order` | subtopic → topic → chapter | **NOT SPECIFIED** — the ladder order is stated, but which levels it must contain is a configuration choice |
| `explanation.grounding.notes_only_min` | 0.75 | stated (≥ 0.75 → notes-only) |
| `explanation.grounding.mostly_notes_min` | 0.50 | stated (0.50–0.75 → mostly-notes; below → general knowledge + review task) |
| `explanation.chunk.min_tokens` / `.max_tokens` | 500 / 800 | stated (theory chunks of approximately 500–800 tokens) |
| `explanation.reports.unpublish_threshold` | 3 | stated (after 3 reports the explanation is unpublished) |
| `explanation.retrieval.vector_weight` | 0.6 | **NOT SPECIFIED** — hybrid vector + keyword retrieval is stated, how the two are weighted is not |
| `explanation.retrieval.min_chunks` | 3 | **NOT SPECIFIED** — "if insufficient, widen" is stated; what counts as insufficient is not |
| `explanation.retrieval.min_candidate_score` | 0.05 | **NOT SPECIFIED** — no floor for a chunk worth putting in the prompt is stated |
| `explanation.approval.mandatory_track_slug_patterns` | `["olympiad"]` | **NOT SPECIFIED** — mandatory approval for Olympiad explanations is stated, but nothing in the schema marks a track as an Olympiad (see B47) |
| `explanation.approval.review_general_knowledge` | true | **NOT SPECIFIED** — a review task below the grounding band is stated; whether *every* general-knowledge explanation also needs one is not |
| `explanation.require_attempt` | true | **SAFETY FLOOR — not tunable.** "Verify student eligibility" is stated without a definition (B48); `false` is rejected outright (B61) |
| `ingestion.confidence.classification_min` | 0.70 | **NOT SPECIFIED** — "low confidence → review" is stated, the number is not |
| `ingestion.confidence.mapping_min` | 0.60 | **NOT SPECIFIED** — same rule, same silence, for syllabus mapping |
| `ingestion.confidence.question_min` | 0.70 | **NOT SPECIFIED** — same, for question extraction |
| `ingestion.confidence.solution_min` | 0.60 | **NOT SPECIFIED** — "low confidence → review" for solution matching is stated, the number is not |
| `ingestion.auto_approval.enabled` | true | **NOT SPECIFIED** — auto-approval rules are stated, whether the feature can be turned off entirely is not |
| `ingestion.auto_approval.min_confidence` | 0.90 | **NOT SPECIFIED** — "only high-confidence extractions" is stated; what counts as high is not |
| `ingestion.auto_approval.audit_sample_rate` | 0.05 | stated (5 % of auto-approved content is sampled for audit) |
| `ingestion.auto_approval.mandatory_review_difficulty_labels` | `[5]` | stated (Olympiad L5 always requires human approval) |
| `ingestion.auto_approval.mandatory_review_track_slug_patterns` | `["olympiad"]` | **NOT SPECIFIED** — the rule names Olympiad content, but nothing in the schema marks a track as an Olympiad (same gap as B47) |
| `ingestion.auto_approval.require_review_for_ocr` | true | **NOT SPECIFIED** as configuration — "OCR content always requires human approval" is stated, so this is a switch that must not be turned off in production; it exists so a test can prove the rule fires |
| `ingestion.approval_reversal_window_hours` | 24 | **NOT SPECIFIED** — approval must be reversible "for a window"; the length is not given |
| `ingestion.ocr_min_page_chars` | 40 | **NOT SPECIFIED** — "OCR fallback when the text layer is insufficient" is stated; what makes a text layer insufficient is not |

Changing any value is a new configuration version through
`POST /v1/admin/tenants/{tenantId}/engine-config` — no code change and no deployment. The
engine reads the active version on every use.

## D. Environment limitations during development

- **npm registry blocked in the build workspaces.** `registry.npmjs.org` is not on the
  egress allowlist. From Phase 2 on, the build and tests run against the `node_modules`
  installed on the developer machine (copied into the build workspace), so no package can be
  added without an `npm install` there. That is why B17 avoids a new JWT dependency.
- **pgvector not installed in the build workspace** (and GitHub also blocked, so it
  couldn't be built from source). Migration `0007_pgvector.sql` is therefore unverified
  until it runs against the `pgvector/pgvector:pg16` Docker image.
- **No PDF library is installable**, so `src/pdf/pdf-document.ts` reads the format directly. It
  handles the common case — a digitally produced PDF whose pages carry an uncompressed or
  Flate-compressed content stream, `Tj`/`TJ`/`'`/`"` operators, object streams, the `/Columns`
  predictor and `/ToUnicode` CMaps — and is deliberately conservative everywhere else: what it cannot
  read it reports as thin or missing text, so the page goes to OCR or to a human. It does not handle
  encrypted documents (refused by policy anyway), `LZWDecode`, CCITT/JBIG2 images or Type 3 fonts.
- **No OCR provider is installable and none is configured.** `OCR_PROVIDER=none` binds
  `UnavailableOcrProvider`, which *refuses* rather than returning empty text, because empty text is
  indistinguishable from a blank page. A page whose text layer is too thin is recorded with whatever
  text it had and raises a review task. **No OCR call has been executed in this workspace.**
- **BullMQ and Redis are not installable either**, so `JOB_QUEUE` is bound to `InProcessJobQueue`:
  sequential, in the API process, off the request's critical path. What it does not give you is
  durability across a restart or a second instance; `ingestion_jobs` records the stage and the attempt
  count, and every stage is idempotent, so a stranded job is re-runnable rather than lost. Moving to
  BullMQ is a change to one provider in `ingestion.module.ts`.
- **No S3 adapter ships and no AWS credentials are needed.** `STORAGE_DRIVER` binds `local` or
  `memory`; `s3` throws at boot. **No S3 request has been made in this workspace.**
- **Requirements document — now provided.** `Adaptive-Practice-App-Requirements.docx` arrived during
  Phase 8 and is the authoritative source from that point on. Every *stated* value in **C** was checked
  against it and none needed changing; the places where the code and the document do not agree are
  listed in **E**, not left implied.

## E. Outstanding against the requirements document

The document arrived during Phase 8. These are the places where the code and the document do not
agree. Nothing here is hidden behind a "planned" label: each entry says what the document asks, what
the code does, and what it would take.

### E1. NFR-S3 — row-level security. **IMPLEMENTED DIFFERENTLY. Deliberate deviation.**

> NFR-S3: "Row-level security enforcing `tenant_id` isolation on every table."

The code does **not** use PostgreSQL `ROW LEVEL SECURITY`. Tenant isolation is enforced by
**composite `(tenant_id, id)` foreign keys on every cross-table reference**, plus `tenant_id` in every
query predicate and in every unique index. The effect NFR-S3 asks for — a row of one organisation can
never be reached from another — is achieved, and the SQL tests assert it directly
(`test/sql/020_tenant_isolation.sql`): an insert that points at another tenant's row is rejected by the
database, not by application code.

Why the deviation: PostgreSQL RLS is enforced per *database role* and per session variable. The API
connects as one role through a shared connection pool, so RLS would require setting a per-request
session variable (`SET LOCAL app.tenant_id`) on a pooled connection and trusting every code path to
do it. A missed `SET` is then a **silent** cross-tenant read — the failure mode is invisible. With
composite foreign keys the failure mode is inverted: a query that forgets `tenant_id` does not
silently widen, it fails to compile or returns nothing, and a write that names the wrong tenant is
refused by the constraint. The isolation is in the schema rather than in the session.

What it does **not** give you: defence against a SQL-injection hole or a hand-written query in a
future migration that omits `tenant_id`. RLS would catch those. If you want NFR-S3 literally,
the honest cost is: a per-request role or `SET LOCAL` on every pooled connection, `ENABLE ROW LEVEL
SECURITY` plus a policy on ~30 tables, and a review of every raw `tx.execute` in the codebase. It is
additive — the composite keys stay — so it can be done later without unpicking anything.
**This needs your decision. It is the only requirement Phase 8 knowingly implements differently.**

### E2. NFR-S2 — admin 2FA. **NOT IMPLEMENTED.**

> NFR-S2: "Passwords hashed with Argon2id. Admin accounts require 2FA with no opt-out."

Argon2id is implemented (`src/auth/password.service.ts`). **2FA is not.** Nothing in the code claims
it is: there is no TOTP secret column, no enrolment flow, no recovery codes, and no second factor in
the login path. An admin account today is protected by a password, the lockout counter and the login
rate limit.

This was not attempted in Phase 8 because it is a feature, not a fix: it needs a secret store on
`users`, an enrolment and recovery-code flow, a second step in the login sequence, a decision about
what happens to an admin who loses their device, and the frontend screens to go with it — none of
which the Phase 8 brief asked for, and all of which touch the authentication path that Phases 1–2
established and the brief freezes. **It is the largest single gap between the code and §15.1.**

### E3. FR-6.6 — revising a question's L-label. **NOT IMPLEMENTED. Threshold NOT SPECIFIED.**

> FR-6.6: "A question's L-label MUST be revisable by the system when observed difficulty diverges
> from the assigned label. Divergence beyond a configured threshold raises an admin review task
> rather than silently overwriting your judgement."

The inputs exist — `difficulty_b` is calibrated on every graded attempt, `calibration_n` counts the
attempts behind it, and `initial_b_by_level` maps labels to `b` — so the divergence is computable. The
rule is not implemented because **the document does not state the threshold**, and this is a value
that cannot be chosen sensibly without seeing real data: too tight and every question raises a task
in week one of the beta, too loose and the rule never fires. It is left explicitly **NOT SPECIFIED**
rather than filled in, consistent with every other unspecified value.
What it needs from you: one number (in `b` units, or in label-widths). Then it is a query, a review
task of an existing kind, and the same "raise a task, never overwrite" shape §7.1 Stage 8 describes.

### E4. §15.2 — minors and DPDP. **NOT IMPLEMENTED. REQUIRES HUMAN / LEGAL REVIEW.**

> "This section requires review by an Indian data-protection lawyer before launch."

None of §15.2 is implemented: no date of birth is collected, there is no parental-consent flow or
consent record, no export or deletion endpoint, and no retention job purging session events after
12 months. **No claim of DPDP compliance is made anywhere in this codebase, and none should be made
on the basis of it.**

What Phase 8 did do is avoid making the problem worse, and that is worth stating precisely because it
is the only part that is actually finished:

* The schema collects no address, phone contacts, precise location or device identifier — §15.2 says
  there is no product reason to store them, and there is nowhere to put them.
* No camera, microphone, screen recording, geolocation or keystroke logging exists anywhere
  (a standing project constraint, and §14's focus tracking is visibility events only).
* Focus tracking is per-session, opt-out by the learner (`users.focus_tracking_opt_out`), and Phase 8
  added the audit row that records who changed that choice and when.
* Every admin action affecting content or user data writes an audit row (NFR-S7), which is what a
  deletion or export request would have to be recorded against.

Deletion is the substantial piece of work: it must cascade to attempts, session events and generated
reports, and `attempts` is append-only by trigger — so "delete a student's data" needs a deliberate
design decision about whether attempts are deleted or anonymised, and that decision has statistical
consequences for every cohort aggregate computed from them. **This needs counsel and then a design;
it is not a coding task with a right answer.**

### E5. Retention and purging. **NOT IMPLEMENTED.**

> §15.2: "raw session events purged after 12 months; aggregated analytics retained."

There is no scheduled job. `session_events` grows without bound. The table is partition-friendly and
the purge is one `DELETE` on `occurred_at`, but there is no scheduler in the deployment yet (the queue
module is `InProcessJobQueue`; see **D**), so a cron-driven purge has nowhere to live until BullMQ or
an external scheduler is in place.

### What is NOT on this list

Everything else in the document that Phase 8 touched is implemented and tested: §6.4's expected-time
median (B62), FR-9.4's per-track mandatory approval (B60, now on `tracks.kind`), NFR-S4's rate
limiting (extended in Phase 8 to the two explanation endpoints that trigger AI generation), NFR-S6's
answer-key isolation (extended in Phase 8 by removing `expectedScore` from the attempt result, which
allowed `difficulty_b` to be solved for), and NFR-S7's audit logging (extended to profile updates,
enrolments and expected-time recalibration).
