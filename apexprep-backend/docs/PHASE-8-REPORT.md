# Phase 8 — AI Home Tutor + General Adaptive Learning Platform

**Status: complete and verified locally.** 938 tests, 181 SQL assertions, typecheck, lint and build
clean; both migration paths verified against real PostgreSQL 16; 32 live smoke checks against a
running server; the frontend byte-for-byte unchanged.

This report says what changed, what was verified and how, and — in §11 and §12 — what is *not* done.
Read those two sections before deciding anything about launch.

---

## 1. What Phase 8 was for

ApexPrep was built over seven phases as an exam-prep backend. Phase 8 makes it a **general adaptive
learning platform** — school learning from Class 1 onward, competitive exams, Olympiads, and
programmes not yet designed — while keeping every JEE/NEET/Olympiad behaviour exactly as it was.

The audit that opened Phase 8 found something worth stating plainly, because it determined the whole
shape of the work: **the adaptive engine was already general.** There is no exam name, no exam year and
no rank anywhere in `src/adaptive/` or in the practice flow. The engine works on θ, `b`, an L1–L5
ladder and a sub-topic; none of those mean "exam". So Phase 8 is **metadata, enrolment and hardening**,
not a rewrite — which is also why Phases 1–7 needed no rework.

Two things were genuinely missing, and migration 0013 adds exactly those two.

---

## 2. Migration 0013 — learning contexts

### A track can say what it is

`tracks` gained seven columns, **all nullable, no defaults, nothing back-filled**:

| Column | Purpose |
| --- | --- |
| `kind` | `school` · `competitive_exam` · `olympiad` · `other` |
| `education_stage` | Free text, e.g. `primary` |
| `grade_label` | What the learner calls it, e.g. `Class 5` |
| `grade_ordinal` | 1–20, **for ordering only** |
| `exam_family` | Free text, e.g. `JEE` |
| `curriculum` | Free text board/curriculum |
| `locale` | BCP-47-style language tag |

Nullable with no back-fill is the point, not laziness: every track that existed before this migration
keeps working and stays *uncategorised*, and `null` means "not stated" rather than any default. A
frontend that read `null` as "competitive exam" would reintroduce the assumption being removed, which
is why §9.1 of FRONTEND-CONTRACT.md says so explicitly.

`exam_family`, `curriculum` and `grade_label` are free text because inventing a controlled vocabulary
of boards, exams and curricula is exactly what the brief forbids. `kind` is the one closed set —
because a safety rule reads it (§4).

Constraints: `kind` limited to the four values the brief names; length checks on the text columns;
`grade_ordinal` between 1 and 20; a locale format check; and `tracks_grade_needs_school_kind`, so a
grade belongs to a track that is about a grade. One index, `tracks_kind_grade_idx`, for the two queries
the metadata exists to serve.

**`grade_ordinal` is not a difficulty.** No grade-to-difficulty mapping is defined anywhere, because
none is specified, and L1–L5 keeps exactly its existing meaning. A test asserts that two tracks
differing only by grade serve the same first question.

**There is no learner *type*.** A learner is a school learner, a competitive learner or a mixed learner
*because of the tracks they are in* — derived, so it cannot contradict itself.

### A learner can be in several tracks

`users.primary_track_id` is one column, so "Class 10 Mathematics, JEE Foundation and Olympiad
Mathematics" could not be represented at all. `learner_tracks` is that relation, and it is **additive**:
`primary_track_id` keeps its meaning and is kept in step by every path that changes which track is
primary, in one transaction. `learner_tracks_one_primary_uq` — a partial unique index over the primary
rows — makes "at most one primary" a database guarantee rather than an application habit.

Composite tenant foreign keys as everywhere else, so an enrolment can never point at another
organisation's learner or track. Leaving is recorded (`status = 'left'`, `left_at`), not deleted, so
history survives and re-enrolling returns to the same row.

**No back-fill, lazy enrolment** (as approved): the migration creates no rows. `ensure()` converts a
learner's existing `primary_track_id` into the enrolment row it always implied — once, idempotently,
inside the caller's transaction, and only for a learner who uses the feature. A learner who never does
behaves exactly as before.

### What 0013 deliberately does not do

* **It does not touch mastery.** `ability_scores` is unique per `(tenant_id, user_id, subtopic_id)` and
  a sub-topic belongs to exactly one track, so a learner in three tracks **already** has three
  independent sets of mastery and no code path can merge them — not because a check forbids it, but
  because there is no row two tracks could share. A test now keeps that true.
  The corollary: shared foundational content across tracks is **not** supported. The same concept in
  two tracks is two sub-topic rows with independent mastery. Explicit and deterministic.
* **No `Program` abstraction** above Track. The hierarchy already carries the meaning; a second one
  would be a new concept for every existing query to ignore.
* **Nothing destructive.** Only `ADD COLUMN` and `CREATE TABLE`.

---

## 3. Migration 0014 — five indexes, each with its query

No index here is speculative. Each is documented in the migration with the exact query it serves, the
file and line that issues it, and why the existing indexes do not cover it.

| Index | What was happening before |
| --- | --- |
| `attempts_session_guess_idx` | The probable-guess count read **every attempt in the table** — `response` jsonb included — about four times per answered question. No index had `session_id`, and a referencing-side foreign key is not an index in PostgreSQL. Partial, because the count only ever asks about guesses. |
| `attempts_user_question_idx` | Question selection's lateral runs once per candidate (a topic-widened pool is hundreds); the closest index had no `user_id`, so each probe read that question's attempts across **every student**. Also serves the explanation endpoint's two per-request reads. |
| `session_items_user_question_idx` | The same shape on the other table: `session_items_question_idx` has no `user_id`. |
| `session_items_user_time_idx` | `session_items_user_seen_idx` puts `subtopic_id` between the equality and the range, so `served_at` could not be an index range and every item the student had ever been served was read and filtered — on every `/next`. |
| `questions_recent_idx` | No existing index contained `created_at`, so the admin question list read all of a tenant's question rows — full `stem` text — and top-N sorted them to keep 21. |

Index-only: no table is rewritten, no behaviour changes.

---

## 4. `tracks.kind = 'olympiad'` is now the Olympiad safety check

Two requirements single out Olympiad content: generated explanations need a human before a student sees
them (FR-9.4 — "Olympiad tracks SHOULD default to mandatory approval"), and L5 Olympiad content is
never auto-approved. Phases 6 and 7 had nothing in the schema to ask, so both matched configured
substrings against the track **slug**. That made a safety rule depend on a name: renaming
`maths-olympiad` to `maths-imo` switched off human review and nothing failed.

`isOlympiadTrack` (`src/common/learning/track-identity.ts`) now answers the question, and
`kind = 'olympiad'` is **sufficient on its own and independent of any name** — with the slug patterns
emptied, `kind` is the whole rule. That is what makes it the actual check.

The slug patterns are **kept as a fallback**, deliberately, for two cases:

1. `kind` is NULL on every pre-0013 track. If `kind` were the only signal, *applying the migration
   would have removed human review from every Olympiad track already in the database* — a safety
   regression shipped by a schema change, which is the worst kind.
2. A track whose slug says Olympiad while its `kind` says otherwise is a contradiction. It is resolved
   toward the reviewer: over-triggering costs an admin a click, under-triggering is the harm the rule
   exists to prevent.

**A second copy of the rule was deleted.** `explanations.service.ts` had its own `requiresApproval`
alongside `visibility.ts`'s `requiresHumanApproval`. Two copies of a safety rule are two rules that can
drift, and drift here means either an explanation held with no review task raised, or one shown that
should have been reviewed. There is now one function, used by both the visibility check and the
review-task path.

Eight tests cover it, including: a renamed Olympiad track is still held *with the slug patterns
switched off*; a school track is not held; an uncategorised track is still held; and a
kind/name contradiction resolves toward the reviewer.

---

## 5. `explanation.require_attempt` is now a floor

An explanation names and works through the correct answer. Serving one for an unattempted question
turns `GET /v1/questions/:id/explanation` into an answer oracle for the whole bank — and the adaptive
engine would then be measuring nothing. A tenant-configurable boolean stood between that and a working
platform.

**Three independent mechanisms now hold it**, and the e2e test exercises all three in one case:

1. An activated `engine_config` version is **immutable** by trigger (AP001), so the live row cannot be
   edited to `false` at all. The test asserts the database refuses it.
2. `parseExplanationParams` **rejects** a stored `false` — it does not quietly ignore it. Silently
   ignoring would leave an admin looking at `false` in the configuration and gated explanations in the
   product with no way to tell which was true. Rejection fails the explanation slice only (the slices
   are independent), so an unsafe value takes out the explanation endpoints and nothing else: **fail
   closed, contained, and loud.**
3. The eligibility check **no longer consults the flag**. A conditional gate is one falsy value away
   from being open, anywhere between `engine_configs` and the service.

The key stays because it is where the rule is written down and where a stricter successor (a minimum
time on the question, say) belongs. It is listed under `safety_floor_keys` in the seed, a new list that
marks keys configuration may not weaken.

---

## 6. §6.4 — the expected-time median

> §6.4: `expected_time_seconds` — "admin-set at first, replaced by observed median once
> `calibration_n` >= 30."

Implemented in `PracticeRepository.recalibrateExpectedTime`, called inside the attempt transaction
after the calibration bump.

**One statement, deliberately.** The median is computed and written in a single `UPDATE`, so no other
transaction can insert an attempt between a read and a write and leave a median that was never true of
the data. Reading the attempts out, taking a median in TypeScript and writing it back is the same
operation with a race in the middle.

**Replay determinism is preserved, by two properties that are both asserted by tests:**

* It does **not** bump `questions.version`. `app_questions_bump_version()` fires only on the columns
  that change what the question *asks* (stem, type, answer key), so calibration is not an edit and
  cached explanations survive. Without this, the 30th attempt on a popular question would be an AI
  bill. `test/sql/070` now asserts it for `expected_time_seconds` specifically.
* Every attempt snapshots `expected_time_seconds_at_attempt` (migration 0010), so an attempt already
  recorded is replayed against the value in force when it was answered — **never against the value it
  caused.** The live run below shows four distinct snapshot values across the attempt history.

**Decisions where §6.4 is silent** (all documented in DECISIONS.md B62):

* **Probable guesses are excluded.** A guess is by definition answered in a small fraction of the
  expected time, so counting guesses pulls the median down → shortens the guess threshold → flags fewer
  guesses. That feedback loop has no fixed point worth landing on, and the quantity being estimated is
  how long the question takes to *answer*, which a guess never measures. Every other outcome counts,
  including `ungraded` (a long-form answer awaiting marking is still a learner who spent that long). A
  *skip* records no attempt row, so there is nothing to exclude.
* **Bounds, not tuning knobs.** `min_seconds`/`max_seconds` mirror the `questions_expected_time_range`
  CHECK, so calibration can never store a value an admin could not have typed, and a pathological
  cohort cannot drive a question's expected time to zero and make every later answer look like a guess.
* **The threshold is tested against `questions.calibration_n`**, the column §6.4 names — not against the
  median's own sample, which is smaller when guesses are excluded.

**One implementation detail worth keeping**, found by a test written to land on exactly `.5`:
`percentile_cont` returns double precision and `round()` on a float rounds **half to even**, so a
median of 114.5 s would have stored 114 while 115.5 stored 116. The median is cast to `numeric` before
rounding, which is half-away-from-zero and identical on every platform.

The value is written only when it actually changes (`WHERE expected_time_seconds <> …`), so a settled
question stops churning: no dead tuple, no trigger work, no audit row per attempt. Each real change
writes an audit row attributed to **SYSTEM**, not to the student who happened to submit the 30th
attempt.

### Verified live, not just in tests

30 real learners answering one question through the HTTP API on a running server:

```
expected_time_seconds: 60 (admin-set) → 112     calibration_n: 36     version: 1 (unchanged)

audit trail                                     median check
SYSTEM  60 → 109   at calibration_n = 30        36 graded non-guess attempts
SYSTEM 109 → 110   at calibration_n = 32        computed median = 112 s  ✓ matches stored
SYSTEM 110 → 111   at calibration_n = 34
SYSTEM 111 → 112   at calibration_n = 36        attempt snapshots: 4 distinct values, 60 … 111
```

It fired at **exactly** `calibration_n = 30`, tracked the median afterwards, wrote **4 audit rows for
36 attempts** (the no-write-when-unchanged clause), left `version` at 1, and every attempt kept the
expected time it was actually measured against.

---

## 7. Security findings fixed

Each was reproduced first, root-caused, fixed minimally, and given a regression test.

| # | Finding | Fix | Regression test |
| --- | --- | --- | --- |
| 1 | **PDF decompression bomb.** A 200 KB PDF whose content stream inflates 1029:1 to 200 MB. Every upload check passes it — well inside any byte limit, one page — so the only place to stop it is the inflate. Measured before the fix: the heap grew by the full inflated size. | `inflateSync(raw, { maxOutputLength: 32 MB })` | A real bomb fixture (`makeBombPdf`); asserts heap growth < 64 MB and that the page is reported *thin* rather than crashing — plus that ordinary compressed PDFs still read. Measured after: **0.7 MB, 26 ms.** |
| 2 | **`expectedScore` leaked `difficulty_b`.** E = 1/(1+10^((b−θ)/elo_scale)) inverts: a client knowing its own θ solves for a column the student projection deliberately withholds. | Removed from `AttemptResultDto` and both assembly sites. Still stored in `attempts` for replay. | Asserts the response has no `expectedScore` *and* that the DB row still holds ≈0.5. Frontend checked: **zero references**, so nothing breaks. |
| 3 | **Idempotency key reuse across items.** Reusing a key for a *different* question replayed the first question's result — including whether it was correct. | `409 IDEMPOTENCY_KEY_REUSED` when the stored attempt names a different `sessionItemId`. | Asserts the 409, that nothing was recorded for the second item, **and** that a genuine retry of the *same* item still replays (that is what the key is for). |
| 4 | **Malformed responses became 500s.** `{optionKeys: "B"}`, `{optionKeys: [1,2]}`, `{value: 4}` pass DTO validation, then reached a string method on a non-string. | Type guards in `grading.ts` returning `invalid(...)` → 400. | Five shapes unit-tested plus numeric and long-form; e2e asserts 400 with `VALIDATION_FAILED`; live smoke asserts 400 **and** that a well-formed answer to the same item is still 201. |
| 5 | **Double-publish race in ingestion.** Read-then-write meant two concurrent publishes both created a question, leaving a duplicate and overwriting the first question's id on the block. | Conditional `UPDATE … WHERE status <> 'published'` claims the block *before* any question is created; `releaseClaim` on failure. | Two concurrent publishes → exactly `[200, 409]`, **one** question created, and the block names the winner. |
| 6 | **Production could run without TLS to the database.** `pg-connection-string` maps a URL with no `sslmode` to `ssl: undefined` — cleartext. | Production `superRefine` requires `sslmode` in `DATABASE_URL`, recommending `verify-full`. | A production fixture without `sslmode` is refused at boot. |
| 7 | **Two cross-tenant update paths lacked `tenant_id`.** `recordFailedLogin` / `recordSuccessfulLogin` matched on `id` alone. | Both now `and(eq(tenantId), eq(id))`. | Covered by the existing tenancy suite; `recordSuccessfulLogin` now returns the fresh row, removing a second read. |
| 8 | **`/health/ready` disclosed the migration count.** | Reports `migrated: true` and throws when the count is 0. | Live smoke asserts the count is absent. |
| 9 | **`/health` bypassed rate limiting entirely** (class-level `@SkipThrottle()`). | `@SkipThrottle()` moved to `/live` only. | — |
| 10 | **Two AI-triggering endpoints had no stricter limit** (NFR-S4). | `@AuthRateLimit()` on the explanation read and the theory-embedding endpoint. | — |
| 11 | **A learner's own profile changes left no audit row** — including `focus_tracking_opt_out`, their privacy choice. | Audit row with before/after, recording only the fields sent. | Covered by the learner-tracks audit test. |

---

## 8. Performance fixes

| Finding | Before | After |
| --- | --- | --- |
| Widened candidate pool | Widening re-queried **every row already in the pool**, each with two per-question laterals — the most expensive part of serving a question | Queries only the *other* sub-topics and concatenates. Safe because the pool is a pure per-question projection (no ORDER BY, LIMIT or cross-row aggregate) and selection breaks ties on question id, not position |
| `activeConfigActivatedAt` | A second query for the `activated_at` of the row `params()` had just read — on **every** explanation request | Returned with the parsed params; the query is deleted |
| Track lookup per ingested block | The same five-table join once per block, for blocks that share a handful of sub-topics | One `tracksOfSubtopics` query before the loop |
| Session-event validation | One round trip **per event** — a client batching fifty focus events made fifty | One `inArray` query for the whole batch |
| `recordSuccessfulLogin` | Update, then a separate read of the same row | `.returning()` |
| Five missing indexes | See §3 | Migration 0014 |

---

## 9. The learner-track API

Four endpoints under `me/tracks`, all `self:profile` (a learner managing their own profile — a new
permission would have meant editing the role map for no new kind of access). Addressed by **track id**,
because a learner has at most one enrolment per track, so the frontend never holds an enrolment id.

```
GET    /v1/me/tracks                 the learner's tracks, primary first
POST   /v1/me/tracks                 { trackId, goalText?, makePrimary? }
PATCH  /v1/me/tracks/{trackId}       { isPrimary?: true, goalText? }
DELETE /v1/me/tracks/{trackId}       leave (kept as history)
```

Behaviour worth stating:

* **An enrolment records intent, not access.** Practice is still authorised per sub-topic through the
  published syllabus. Making enrolment a gate would change who may practise what — not a Phase 8
  requirement — and would lock out every existing learner, who after lazy enrolment has no row yet.
* **The first track becomes primary**; later ones do not take the slot unless asked.
* **`isPrimary: false` is refused** (400) rather than accepted as a no-op. There is no "not primary"
  state: make another track primary, or leave this one.
* **Leaving promotes nothing.** The learner is left with no primary track, because which track matters
  most is theirs to say and no rule for choosing is specified.
* **Re-enrolling reactivates the same row** — same `id`, goal text intact — rather than accumulating a
  second history. No progress is deleted: mastery is per sub-topic and untouched.
* `PATCH /v1/me/profile` with `primaryTrackId` still works and now keeps the enrolment in step, in one
  transaction, so the two representations can never disagree.

---

## 10. Verification — what was actually run

Everything below was executed in this workspace. Nothing in this section is inferred.

### Tests: 938 passing, 38 suites

| Suite | Count |
| --- | --- |
| Unit (26 suites) | 556 |
| e2e (12 suites, real PostgreSQL 16 + real HTTP) | 382 |
| SQL assertions (11 files) | 181 |

New in Phase 8: `test/e2e/learner-tracks.e2e-spec.ts` (22), `test/e2e/generalisation.e2e-spec.ts` (10),
`test/sql/110_expected_time_calibration.sql` (17), plus additions to the practice, explanation,
ingestion, grading, PDF and engine-param suites.

Test groups, by what they establish:

| Group | Establishes |
| --- | --- |
| A | A learner holds a school class, a competitive exam and an Olympiad at once, each with its own goal |
| B | Exactly one primary track, guaranteed under concurrency, with `users.primary_track_id` in step |
| C | The pre-0013 profile endpoint still works; enrolments materialise lazily; a learner with no track is untouched |
| D | Leaving keeps history, promotes nothing, and rejoining returns to the same row |
| E | Mastery stays isolated per track when a learner practises in another |
| F | Enrolment is scoped per tenant and per learner, and validated |
| G | Enrolling, moving the primary track and leaving are all audited |
| H | A Class 5 learner goes enrol → syllabus → session → serve → graded attempt → explanation through the ordinary path |
| I | A grade orders tracks and changes no difficulty; grade/kind validation is refused with the field named |
| J | A track with every metadata column null behaves exactly as before (the state of every existing track) |

> **One honest note on labelling.** The Phase 8 brief numbered its required test groups A–J. That
> message was lost to a context compaction before this report was written, so the letters above are my
> mapping onto the subject matter, not a verbatim reproduction of the brief's list. The coverage is
> what matters and it is described plainly; **if your A–J differed, tell me and I will re-map or fill
> gaps.** I would rather flag this than imply a correspondence I cannot check.

### Typecheck, lint, build

`npm run typecheck` clean · `eslint {src,test,scripts}` clean · `npm run build` clean.

### Migrations — both paths, real PostgreSQL 16

* **Clean database**, 0001 → 0014: applies (0007 pgvector skipped, unavailable here — see §12).
* **Existing database**: migrated to 0012, populated with a tenant, a learner with a primary track, a
  full syllabus, a published question, an engine config, a session and an answered attempt; **then**
  0013 + 0014 applied. Result: every row intact, `learner_tracks` **empty** (no back-fill), every new
  `tracks` column NULL, the learner still pointing at their primary track, and the attempt's
  `expected_time_seconds_at_attempt` snapshot unchanged.
* **The two databases are structurally identical**: 479 columns, 137 indexes, 380 constraints — diffed,
  zero differences. The upgrade path lands exactly where a clean install does.

### Live smoke: 32 checks, 0 failures

Against `dist/main.js` on a real port with a real database: health and the `/ready` disclosure fix;
track metadata round-trip through the admin API including both validation refusals; the full enrolment
lifecycle including the concurrency and refusal cases; a Class 5 learner served a real question with no
answer key in the payload and a graded attempt; and the malformed-response, attempt-gate and
cross-tenant checks.

Three of those checks failed on the first run **for reasons in my own smoke script, not the
application**: I reused an already-answered item (the 409 fired before grading), picked a *retired*
question (correctly 404 for a student), and hardcoded an integer answer for a multiple-choice question.
All three are recorded here because each one was the application being right.

### Beta support harness — run, not just written

* `npm run beta:learners` — a cohort reproducible from one seed string. Verified: 6 learners, 7
  enrolments (a third in two tracks, chosen by the seed, not chance); re-running reports **0 new**;
  `--list` reproduces the exact credentials. 30 learners were then generated and used for the live
  §6.4 run above.
* `npm run beta:load` — drives login → tracks → tree → session → serve/answer, reporting p50/p90/p99
  and max per request. Verified against the live server. It answers each question **by its served
  type**, so a 4xx in the report means the server refused something it should have accepted; and it
  treats `/next` 409 (nothing left to serve) as a normal end rather than an error, because a column
  that cries wolf is worse than no column. It found the login rate limiter (NFR-S4) working, which is
  documented in the script rather than worked around.

**The closed beta itself is REQUIRES HUMAN / EXTERNAL EXECUTION.** These are tools for running it; ~50
real students over three weeks is not something this workspace can perform.

### Frontend: untouched, verified

`C:\project folder\apexprep\apexprep\apexprep-frontend` — 70 files, manifest MD5
**`e356bbf3ef47137aca04971af95dfcc3`**, identical to the baseline recorded before Phase 8 began. The
only frontend interaction in Phase 8 was one read-only `grep`, to check that nothing references the
removed `expectedScore` field (nothing does).

---

## 11. Required deployment step — read this before deploying

**Adding a required engine parameter breaks an existing database until a new configuration version is
activated.** The engine has no defaults by design: a missing parameter is refused loudly rather than
filled in with a number nobody chose. Phase 8 adds one such parameter (`expected_time`), so a database
whose active configuration predates it answers **422 `ENGINE_CONFIG_INVALID`** on every practice
request, naming the missing key.

**This was observed live during verification, not predicted.** Practice stopped working on the
already-seeded verify database until the configuration was upgraded.

```
npm run db:migrate          # 0013 + 0014
npm run engine:upgrade      # dry run: prints what would change, changes nothing
npm run engine:upgrade -- --apply
```

The script inserts the next `engine_config` version per tenant carrying **that tenant's existing
parameters plus the missing block**, and activates it in one transaction. It validates the merged
object before storing it, refuses a tenant whose configuration would still be invalid (rather than
replacing one broken configuration with another), and skips a tenant that already has the key. It is a
dry run by default.

Why a script and not a migration: an activated `engine_config` version is **immutable by trigger**
(AP001), so a migration cannot edit one — it would have to *activate a new version* for every tenant,
changing an organisation's live configuration behind its back and deactivating whatever version its
admin had chosen. `attempts.engine_config_id` still points at the version each past attempt was graded
under, so replay is unaffected either way.

Verified: dry run, apply, and a second apply reporting **0 upgraded**. v1 remains in the table,
deactivated, for replay.

---

## 12. Not done — the honest list

### Against the requirements document (DECISIONS.md §E has the full reasoning)

| Requirement | Status |
| --- | --- |
| **NFR-S3 — row-level security** | **IMPLEMENTED DIFFERENTLY. Deliberate deviation — needs your decision.** Tenant isolation uses composite `(tenant_id, id)` foreign keys on every cross-table reference, plus `tenant_id` in every predicate and unique index. The effect NFR-S3 asks for is achieved and the SQL tests assert it. PostgreSQL RLS is *not* used: it is enforced per database role and session variable, so over a shared pool it needs `SET LOCAL app.tenant_id` on every request and a missed `SET` is a **silent** cross-tenant read. Composite keys invert the failure mode — a query that forgets `tenant_id` fails or returns nothing. What RLS would add: defence against a SQL-injection hole or a future hand-written query that omits `tenant_id`. It is additive if you want it. |
| **NFR-S2 — admin 2FA** | **NOT IMPLEMENTED.** Argon2id is. There is no TOTP secret, no enrolment flow, no recovery codes, no second login step. Admins are protected by password + lockout + rate limit. Deliberately not attempted: it is a feature touching the frozen auth path, not a fix. **The largest single gap against §15.1.** |
| **FR-6.6 — revising a question's L-label** | **NOT IMPLEMENTED. Threshold left NOT SPECIFIED**, as instructed. The inputs exist (`difficulty_b`, `calibration_n`, `initial_b_by_level`), so the divergence is computable. It needs one number from you — too tight and every question raises a task in beta week one, too loose and it never fires. |
| **§15.2 — minors and DPDP** | **NOT IMPLEMENTED. REQUIRES HUMAN / LEGAL REVIEW.** No date of birth, no parental-consent flow or record, no export/deletion endpoint, no retention purge. **No claim of DPDP compliance is made anywhere in this codebase and none should be made on the basis of it.** What is genuinely done: the schema collects no address, phone contacts, precise location or device identifier; no camera, microphone, screen recording, geolocation or keystroke logging exists; focus tracking is learner-opt-out and its changes are now audited; every admin action affecting content or user data writes an audit row. Deletion is the substantial work — it must cascade to attempts, which are append-only by trigger, so "delete a student's data" needs a decision about deleting versus anonymising, and that has statistical consequences for every cohort aggregate. **Counsel first, then a design.** |
| **§15.2 retention** | **NOT IMPLEMENTED.** `session_events` grows without bound. The purge is one `DELETE` on `occurred_at`, but there is no scheduler in the deployment yet. |

### Out of scope by instruction

No payments, subscriptions or billing — and **no `isPremium` / `isPaid` / `hasSubscription` anywhere in
the codebase**, checked. No Class 1–12 production content: the dev seed carries a **two-question**
Class 5 fixture whose own description reads "Not a syllabus", because thousands of rows of invented
schoolwork that no teacher has checked is worse than none. No mobile app. No Phase 9.

### Still unavailable in this workspace (unchanged from Phase 7)

pgvector (migration 0007 skipped; semantic retrieval degrades to keywords), OCR (`OCR_PROVIDER=none`
refuses rather than returning empty text), S3 (`local`/`memory` only), BullMQ/Redis
(`InProcessJobQueue`), and no AI credentials (the explanation tests run the whole real path and replace
only the last hop). **No OCR, S3, pgvector or external AI call has been executed in this workspace, and
nothing in this report claims otherwise.**

---

## 13. Files

**Migrations (new, applied):** `0013_learning_contexts.sql`, `0014_performance_indexes.sql`
**Seeds (new):** `database/seeds/dev/002_dev_learning_contexts.sql`
**Module (new):** `src/learner-tracks/` — controller, service, repository, DTOs, module
**Shared (new):** `src/common/learning/track-identity.ts`
**Scripts (new):** `scripts/make-beta-learners.ts`, `scripts/load-test.ts`,
`scripts/upgrade-engine-params.ts`
**Tests (new):** `test/e2e/learner-tracks.e2e-spec.ts`, `test/e2e/generalisation.e2e-spec.ts`,
`test/sql/110_expected_time_calibration.sql`
**Docs:** this file, plus DECISIONS.md (§B60–B68, §E, B54 re-filed, parameter table),
ARCHITECTURE.md (§11b, data model, security checklist, phase plan), FRONTEND-CONTRACT.md (§9)

Modified: the explanation, practice, ingestion, syllabus, users, auth, health, pdf and config modules;
the engine parameter schema and both parameter fixtures; nine existing test files.

**Phases 1–7 behaviour is unchanged.** Every pre-existing test passes untouched except where a test
asserted something Phase 8 deliberately changed: the `expectedScore` assertion became a leak-regression
guard, and the dev-seed structural assertions now expect two tracks instead of one.
