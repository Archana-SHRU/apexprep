-- =============================================================================
-- 0015_learning_ai
--
-- WHY THIS MIGRATION IS NEEDED
--
-- Four student-facing AI capabilities build on the existing explanation stack
-- (the provider boundary, theory retrieval, grounding, the answer grader):
-- revision notes, fresh question generation, a tutor for follow-up doubts, and
-- "explain visually". Each produces something that must be cached, audited or
-- carried across requests, and the existing tables were checked first:
--
--   * `explanations` is keyed by (question, version, option). Revision notes are
--     keyed by a syllabus scope, not a question, so they cannot live there
--     without making `question_id` nullable and weakening every CHECK on it.
--   * `questions` records a question, not how it came to exist. A generated
--     question is stored there as an ordinary question — the adaptive engine,
--     grading and explanations must treat it exactly like any other — so its
--     provenance (provider, model, prompt, source blocks, target level,
--     validation outcome) needs a row of its own, and so do the attempts that
--     failed validation, which never become questions at all.
--   * Nothing holds a conversation. The tutor needs a short, persistent history
--     per student and context so a follow-up is answered in context.
--   * `question_assets` attaches images that are *part of* a question (stem,
--     option, solution). A visual explanation is a learning aid the student asks
--     for before answering; filing it as `solution` would be wrong and would put
--     it where solution-reveal rules apply. It gets its own cache row, and when
--     it is a raster image the bytes go through object storage and a
--     `content_assets` row exactly like an uploaded file — never into PostgreSQL.
--
-- `content_assets` gains one kind, `generated_visual`: the existing `figure`
-- kind is defined as derived from a source PDF (CHECK
-- content_assets_derived_has_parent), which a generated image is not.
--
-- NOT DESTRUCTIVE: new tables, and one widened CHECK. Nothing is renamed,
-- dropped, narrowed or back-filled.
-- =============================================================================

-- ---------------------------------------------------------------- content_assets

ALTER TABLE content_assets DROP CONSTRAINT content_assets_kind_valid;
ALTER TABLE content_assets
  ADD CONSTRAINT content_assets_kind_valid
  CHECK (kind IN ('source_pdf', 'page_image', 'figure', 'report_pdf', 'generated_visual'));

-- ---------------------------------------------------------------- revision_notes

CREATE TABLE revision_notes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  -- The syllabus node the notes summarise. Polymorphic by level, so there is no
  -- foreign key; the service resolves the node through the published syllabus.
  scope_level       text NOT NULL,
  scope_id          uuid NOT NULL,
  -- sha256 over the (block id, content hash) pairs of every source block: the
  -- cache key's content half. Any edit, addition or removal changes it.
  source_hash       text NOT NULL,
  source_block_ids  uuid[] NOT NULL DEFAULT '{}',
  prompt_version    text NOT NULL,
  provider          text,
  model             text,
  status            text NOT NULL DEFAULT 'active',
  content           jsonb NOT NULL,
  grounding_score   numeric(4,3),
  diagnostics       jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_by      uuid,
  generated_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revision_notes_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT revision_notes_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT revision_notes_user_fk FOREIGN KEY (tenant_id, generated_by) REFERENCES users (tenant_id, id),
  CONSTRAINT revision_notes_scope_valid CHECK (scope_level IN ('track', 'subject', 'chapter', 'topic', 'subtopic')),
  CONSTRAINT revision_notes_status_valid CHECK (status IN ('active', 'superseded', 'rejected')),
  CONSTRAINT revision_notes_hash_format CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT revision_notes_content_object CHECK (jsonb_typeof(content) = 'object'),
  CONSTRAINT revision_notes_grounding_range CHECK (grounding_score IS NULL OR grounding_score BETWEEN 0 AND 1),
  -- Notes are only ever written from source content: an active row names its sources.
  CONSTRAINT revision_notes_active_has_sources CHECK (status <> 'active' OR cardinality(source_block_ids) > 0)
);

-- One current set of notes per scope; a regeneration supersedes the old row first.
CREATE UNIQUE INDEX revision_notes_one_active_uq ON revision_notes (tenant_id, scope_level, scope_id) WHERE status = 'active';
CREATE INDEX revision_notes_lookup_idx ON revision_notes (tenant_id, scope_level, scope_id, generated_at DESC);

CREATE TRIGGER revision_notes_set_updated_at BEFORE UPDATE ON revision_notes
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------- generated_questions

CREATE TABLE generated_questions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  -- The question this generation became. NULL exactly when it was rejected: a
  -- generation that failed validation never reaches the question bank.
  question_id       uuid,
  subtopic_id       uuid NOT NULL,
  requested_by      uuid,
  status            text NOT NULL,
  question_type     text NOT NULL,
  -- What the adaptive engine asked for: its target difficulty for this learner
  -- and the level band that target falls in. The engine chose; this records it.
  target_level      smallint NOT NULL,
  target_b          numeric(8,2) NOT NULL,
  provider          text,
  model             text,
  prompt_version    text NOT NULL,
  source_block_ids  uuid[] NOT NULL DEFAULT '{}',
  source_hash       text NOT NULL,
  -- Normalised stem, for exact-duplicate detection across generations.
  stem_fingerprint  text,
  validation        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The model's worked solution. Kept for review and audit; the answer key the
  -- student is graded against lives on the question row, never here.
  solution          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generated_questions_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT generated_questions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT generated_questions_question_fk FOREIGN KEY (tenant_id, question_id) REFERENCES questions (tenant_id, id),
  CONSTRAINT generated_questions_subtopic_fk FOREIGN KEY (tenant_id, subtopic_id) REFERENCES subtopics (tenant_id, id),
  CONSTRAINT generated_questions_user_fk FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id),
  CONSTRAINT generated_questions_status_valid CHECK (status IN ('published', 'in_review', 'rejected')),
  CONSTRAINT generated_questions_question_pair CHECK ((status = 'rejected') = (question_id IS NULL)),
  CONSTRAINT generated_questions_type_valid CHECK (question_type IN ('single_correct', 'multi_correct', 'integer', 'numeric',
                                                                       'matrix_match', 'assertion_reason', 'long_form')),
  CONSTRAINT generated_questions_level_range CHECK (target_level BETWEEN 1 AND 5),
  CONSTRAINT generated_questions_hash_format CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  -- Generated from source content, always.
  CONSTRAINT generated_questions_has_sources CHECK (status = 'rejected' OR cardinality(source_block_ids) > 0)
);

CREATE UNIQUE INDEX generated_questions_question_uq ON generated_questions (tenant_id, question_id) WHERE question_id IS NOT NULL;
CREATE INDEX generated_questions_subtopic_idx ON generated_questions (tenant_id, subtopic_id, created_at DESC);
CREATE INDEX generated_questions_requester_idx ON generated_questions (tenant_id, requested_by, created_at DESC);

CREATE TRIGGER generated_questions_set_updated_at BEFORE UPDATE ON generated_questions
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------- tutor

CREATE TABLE tutor_conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  -- Every conversation is about something in the syllabus: the tutor is not a
  -- general chatbot, and this is where that is anchored.
  subtopic_id       uuid NOT NULL,
  question_id       uuid,
  question_version  integer,
  status            text NOT NULL DEFAULT 'open',
  last_message_at   timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tutor_conversations_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT tutor_conversations_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT tutor_conversations_subtopic_fk FOREIGN KEY (tenant_id, subtopic_id) REFERENCES subtopics (tenant_id, id),
  CONSTRAINT tutor_conversations_question_fk FOREIGN KEY (tenant_id, question_id) REFERENCES questions (tenant_id, id),
  CONSTRAINT tutor_conversations_status_valid CHECK (status IN ('open', 'closed')),
  CONSTRAINT tutor_conversations_question_pair CHECK ((question_id IS NULL) = (question_version IS NULL))
);

CREATE INDEX tutor_conversations_user_idx ON tutor_conversations (tenant_id, user_id, last_message_at DESC);

CREATE TRIGGER tutor_conversations_set_updated_at BEFORE UPDATE ON tutor_conversations
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE tutor_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  conversation_id   uuid NOT NULL,
  role              text NOT NULL,
  intent            text NOT NULL DEFAULT 'free',
  body              text NOT NULL,
  -- For tutor turns: provider, model, prompt version, grounding blocks and the
  -- leak-check outcome. Never projected to the student.
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tutor_messages_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT tutor_messages_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES tutor_conversations (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT tutor_messages_role_valid CHECK (role IN ('student', 'tutor')),
  CONSTRAINT tutor_messages_intent_valid CHECK (intent IN ('free', 'hint', 'why_wrong', 'simplify', 'explain_step', 'another_example', 'concept')),
  CONSTRAINT tutor_messages_body_length CHECK (length(btrim(body)) BETWEEN 1 AND 8000)
);

CREATE INDEX tutor_messages_conversation_idx ON tutor_messages (tenant_id, conversation_id, created_at);

-- ---------------------------------------------------------------- visual_explanations

CREATE TABLE visual_explanations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  question_id       uuid NOT NULL,
  question_version  integer NOT NULL,
  prompt_version    text NOT NULL,
  -- sha256 over the theory the analysis was grounded in; a change regenerates.
  source_hash       text NOT NULL,
  status            text NOT NULL DEFAULT 'active',
  -- What the analysis chose. 'none' is a real, cached outcome: the analysis
  -- judged that a picture would not help, and says why in `decision`.
  visual_type       text NOT NULL,
  decision          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The validated scene for a drawn visual; NULL for 'none' and for an image.
  spec              jsonb,
  -- The stored image for visual_type = 'image'; bytes live in object storage.
  asset_id          uuid,
  provider          text,
  model             text,
  validation        jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by      uuid,
  generated_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visual_explanations_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT visual_explanations_question_fk FOREIGN KEY (tenant_id, question_id) REFERENCES questions (tenant_id, id),
  CONSTRAINT visual_explanations_asset_fk FOREIGN KEY (tenant_id, asset_id) REFERENCES content_assets (tenant_id, id),
  CONSTRAINT visual_explanations_user_fk FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id),
  CONSTRAINT visual_explanations_status_valid CHECK (status IN ('active', 'superseded', 'rejected')),
  CONSTRAINT visual_explanations_type_valid CHECK (visual_type IN ('diagram', 'graph', 'step_by_step', 'animation', 'illustration', 'image', 'none')),
  CONSTRAINT visual_explanations_hash_format CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  -- A drawn visual has a scene; an image has a stored asset; 'none' has neither.
  CONSTRAINT visual_explanations_payload CHECK (
    CASE visual_type
      WHEN 'none'  THEN spec IS NULL AND asset_id IS NULL
      WHEN 'image' THEN asset_id IS NOT NULL
      ELSE spec IS NOT NULL AND jsonb_typeof(spec) = 'object'
    END OR status = 'rejected')
);

CREATE UNIQUE INDEX visual_explanations_one_active_uq ON visual_explanations (tenant_id, question_id, question_version) WHERE status = 'active';

CREATE TRIGGER visual_explanations_set_updated_at BEFORE UPDATE ON visual_explanations
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
