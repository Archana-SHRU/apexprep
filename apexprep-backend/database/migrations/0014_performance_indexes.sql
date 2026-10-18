-- =============================================================================
-- 0014_performance_indexes
--
-- WHY THIS MIGRATION IS NEEDED
--
-- Five indexes, each added because a specific query in a hot path has no index
-- that serves it. No index here is speculative: the query it serves is quoted
-- with the file and line that issues it, and in every case the existing indexes
-- were checked first and do not cover the predicate.
--
-- Measured against the closed beta the requirements describe — ~50 students,
-- 2+ tracks, three weeks, so tens of thousands of attempts — these are the reads
-- that degrade from "index probe" to "scan the whole table" as attempts
-- accumulate. Index-only additions: no table is rewritten and no behaviour
-- changes.
-- =============================================================================

-- 1. src/practice/practice.repository.ts — countProbableGuesses
--
--    SELECT count(*) FROM attempts
--     WHERE tenant_id = $1 AND session_id = $2 AND probable_guess = true
--
--    Called up to twice per `GET /practice/sessions/:id/next` and twice per
--    attempt submission (the probable-guess pause rule, and again when the
--    session DTO is built). `attempts` is indexed on
--    (tenant_id, user_id, subtopic_id, …), (tenant_id, user_id, created_at),
--    (tenant_id, question_id, …) and (tenant_id, subtopic_id, …) — none of them
--    on session_id, and a referencing-side foreign key is not an index in
--    PostgreSQL. So this counted rows by reading every attempt in the table,
--    including the `response` jsonb, roughly four times per answered question.
--
--    Partial, because the count only ever asks about guesses: a session has 0-3
--    of them, so the index stays tiny however large `attempts` grows.
CREATE INDEX attempts_session_guess_idx ON attempts (tenant_id, session_id)
  WHERE probable_guess;

-- 2. src/practice/practice.repository.ts — candidatePool's lateral subqueries,
--    and src/explanations/explanations.repository.ts — hasAttempted, lastWrongOption
--
--    … LATERAL (SELECT max(a.created_at) FROM attempts a
--                WHERE a.tenant_id = q.tenant_id AND a.user_id = $1 AND a.question_id = q.id)
--    SELECT EXISTS (SELECT 1 FROM attempts WHERE tenant_id = $1 AND user_id = $2 AND question_id = $3)
--    SELECT … FROM attempts WHERE tenant_id = $1 AND user_id = $2 AND question_id = $3
--      ORDER BY created_at DESC, id DESC LIMIT 1
--
--    Question selection runs the lateral once per candidate question — a
--    40-question pool is 40 probes, a pool widened to a topic can be several
--    hundred — and the explanation endpoint runs the other two on every request.
--    The closest existing index is (tenant_id, question_id, created_at), which
--    has no user_id, so each probe read that question's attempts across *every*
--    student and filtered in the executor.
--
--    created_at DESC last makes `max(created_at)` and the `LIMIT 1` single index
--    steps rather than sorts.
CREATE INDEX attempts_user_question_idx ON attempts (tenant_id, user_id, question_id, created_at DESC);

-- 3. src/practice/practice.repository.ts — candidatePool's unanswered-item lateral
--
--    … LATERAL (SELECT 1 FROM session_items i
--                WHERE i.tenant_id = q.tenant_id AND i.user_id = $1
--                  AND i.question_id = q.id AND i.status <> 'answered')
--
--    The same shape as (2) on the other table. `session_items_question_idx` is
--    (tenant_id, question_id) with no user_id, so this too scanned one question's
--    rows across all students, once per candidate.
CREATE INDEX session_items_user_question_idx ON session_items (tenant_id, user_id, question_id, served_at DESC);

-- 4. src/practice/practice.repository.ts — seenDuplicateGroups, the session_items arm
--
--    SELECT … FROM session_items
--     WHERE tenant_id = $1 AND user_id = $2 AND served_at > $3
--
--    The only user-scoped index is
--    session_items_user_seen_idx (tenant_id, user_id, subtopic_id, served_at DESC):
--    `subtopic_id` sits between the equality and the range, so `served_at` could
--    not be an index range and every item the student had ever been served was
--    read and filtered. This runs on every `/next`, and `session_items` grows by
--    one row per question served.
CREATE INDEX session_items_user_time_idx ON session_items (tenant_id, user_id, served_at DESC);

-- 5. src/questions/questions.repository.ts — the admin question listing
--
--    SELECT … FROM questions
--     WHERE tenant_id = $1 AND deleted_at IS NULL
--     ORDER BY created_at DESC, id DESC LIMIT 21
--
--    with a keyset cursor on the same pair. No existing index contains
--    `created_at` (`questions_admin_idx` is (tenant_id, status,
--    primary_subtopic_id, difficulty_label)), so both the unfiltered first page
--    and every cursor page read all of the tenant's question rows — full `stem`
--    text included — and top-N sorted them to keep 21.
CREATE INDEX questions_recent_idx ON questions (tenant_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
