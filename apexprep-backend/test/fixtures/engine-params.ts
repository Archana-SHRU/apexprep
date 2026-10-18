import { parseEngineParams, type EngineParams } from '../../src/adaptive/engine-params';
import { parseExplanationParams, type ExplanationParams } from '../../src/explanations/explanation-params';
import { parseIngestionParams, type IngestionParams } from '../../src/ingestion/ingestion-params';

/**
 * A complete, valid parameter set for tests, matching the development seed.
 *
 * `provisional_keys` lists the values the requirements document does **not** specify. Tests
 * assert behaviour against the parameters they pass in, never against a value baked into the
 * engine, and every test that depends on a threshold overrides it explicitly — so a provisional
 * value being wrong changes no test's meaning.
 *
 * `safety_floor_keys` lists keys that are not tunable at all: a configuration that weakens one is
 * rejected rather than honoured. They are listed here so the distinction is visible where the
 * numbers are, and not only in the code that enforces it.
 */
export const SEED_ENGINE_PARAMS: Record<string, unknown> = {
  "provisional": true,
  "requirements_note": "Values marked in provisional_keys are NOT specified by the requirements; everything else follows the stated adaptive-engine requirements. Keys in safety_floor_keys are not tunable: a configuration that weakens one is rejected, not honoured.",
  "safety_floor_keys": [
    "explanation.require_attempt"
  ],
  "provisional_keys": [
    "level_bands",
    "initial_b_by_level",
    "inactivity_decay.per_period_days",
    "inactivity_decay.theta_points_per_period",
    "inactivity_decay.max_total_points",
    "inactivity_decay.floor_theta",
    "near_duplicate.trigram_similarity",
    "near_duplicate.exclude_days",
    "probable_guess.question_update",
    "probe.updates_question_b",
    "exclusion_includes_skipped",
    "benchmark.min_qualifying_students",
    "rag.top_k",
    "rag.widen_order",
    "explanation.retrieval.vector_weight",
    "explanation.retrieval.min_chunks",
    "explanation.retrieval.min_candidate_score",
    "explanation.approval.mandatory_track_slug_patterns",
    "explanation.approval.review_general_knowledge",
    "ingestion.confidence.classification_min",
    "ingestion.confidence.mapping_min",
    "ingestion.confidence.question_min",
    "ingestion.confidence.solution_min",
    "ingestion.auto_approval.enabled",
    "ingestion.auto_approval.min_confidence",
    "ingestion.auto_approval.mandatory_review_track_slug_patterns",
    "ingestion.auto_approval.require_review_for_ocr",
    "ingestion.approval_reversal_window_hours",
    "ingestion.ocr_min_page_chars"
  ],
  "elo_scale": 400,
  "k_student": {
    "initial": 32,
    "initial_attempts": 20,
    "steady": 16,
    "low_calibration_threshold": 10,
    "low_calibration_factor": 0.5
  },
  "k_question": {
    "uncalibrated": 24,
    "calibrated_after": 50,
    "steady": 8
  },
  "cold_start": {
    "level": 2,
    "seed_from_parent_topic": true
  },
  "level_bands": [
    {
      "level": 1,
      "theta_min": null,
      "theta_max": 900
    },
    {
      "level": 2,
      "theta_min": 900,
      "theta_max": 1100
    },
    {
      "level": 3,
      "theta_min": 1100,
      "theta_max": 1300
    },
    {
      "level": 4,
      "theta_min": 1300,
      "theta_max": 1500
    },
    {
      "level": 5,
      "theta_min": 1500,
      "theta_max": null
    }
  ],
  "initial_b_by_level": {
    "1": 800,
    "2": 1000,
    "3": 1200,
    "4": 1400,
    "5": 1600
  },
  "target_success": 0.72,
  "placement": {
    "enabled": true,
    "question_count": 8
  },
  "promotion": {
    "consecutive_correct": 2,
    "within_expected_time_factor": 1.25,
    "window": 4,
    "correct_in_window": 3
  },
  "demotion": {
    "consecutive_incorrect": 2,
    "window": 5,
    "incorrect_in_window": 3
  },
  "l1_protection": {
    "block_demotion": true,
    "theta_floor": null
  },
  "l5_ceiling": {
    "block_promotion": true,
    "theta_cap": null
  },
  "probable_guess": {
    "requires_incorrect": true,
    "max_time_fraction_of_expected": 0.25,
    "theta_update": "skip",
    "question_update": "skip",
    "counts_towards_level": false,
    "pause_session_after": 3
  },
  "expected_time": {
    "recalibrate_after_attempts": 30,
    "exclude_probable_guesses": true,
    "min_seconds": 5,
    "max_seconds": 7200
  },
  "probe": {
    "every_n": 5,
    "levels_above_target": 0.5,
    "updates_theta": true,
    "updates_question_b": true,
    "counts_towards_promotion": true,
    "counts_towards_demotion": false
  },
  "inactivity_decay": {
    "after_days": 21,
    "per_period_days": 7,
    "theta_points_per_period": 10,
    "max_total_points": 150,
    "floor_theta": null
  },
  "exclusion_days": 30,
  "exclusion_includes_skipped": true,
  "near_duplicate": {
    "trigram_similarity": 0.85,
    "exclude_days": 30
  },
  "content_gap": {
    "min_eligible": 5,
    "widen_to_topic": true,
    "open_review_task": true
  },
  "benchmark": {
    "window_days": 90,
    "top_k": 10,
    "min_qualifying_students": 30
  },
  "rag": {
    "top_k": 5,
    "widen_order": [
      "subtopic",
      "topic",
      "chapter"
    ]
  },
  "explanation": {
    "chunk": { "min_tokens": 500, "max_tokens": 800 },
    "retrieval": { "vector_weight": 0.6, "min_chunks": 3, "min_candidate_score": 0.05 },
    "grounding": { "notes_only_min": 0.75, "mostly_notes_min": 0.5 },
    "approval": { "mandatory_track_slug_patterns": ["olympiad"], "review_general_knowledge": true },
    "reports": { "unpublish_threshold": 3 },
    "require_attempt": true
  },
  "ingestion": {
    "confidence": { "classification_min": 0.7, "mapping_min": 0.6, "question_min": 0.7, "solution_min": 0.6 },
    "auto_approval": {
      "enabled": true,
      "min_confidence": 0.9,
      "audit_sample_rate": 0.05,
      "mandatory_review_difficulty_labels": [5],
      "mandatory_review_track_slug_patterns": ["olympiad"],
      "require_review_for_ocr": true
    },
    "approval_reversal_window_hours": 24,
    "ocr_min_page_chars": 40
  }
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const current = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && current && typeof current === 'object' && !Array.isArray(current)
        ? merge(current as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

/** Validated parameters with the given overrides applied (deep-merged). */
export function engineParams(overrides: DeepPartial<EngineParams> = {}): EngineParams {
  const parsed = parseEngineParams(merge(SEED_ENGINE_PARAMS, overrides));
  if (!parsed.ok) throw new Error(`test params are invalid: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

/** The raw object, for tests that post parameters over HTTP. */
export function engineParamsJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return merge(SEED_ENGINE_PARAMS, overrides);
}

/**
 * The explanation slice, validated by its own schema (`src/explanations/explanation-params.ts`).
 * Separate from `engineParams` because the two schemas are validated independently: adding
 * explanation settings must not be able to invalidate a configuration the adaptive engine runs on.
 */
export function explanationParams(overrides: Record<string, unknown> = {}): ExplanationParams {
  const parsed = parseExplanationParams(merge(SEED_ENGINE_PARAMS, overrides));
  if (!parsed.ok) throw new Error(`test explanation params are invalid: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

/**
 * The ingestion slice, validated by its own schema (`src/ingestion/ingestion-params.ts`).
 *
 * Separate for the same reason as the explanation slice: a configuration that ingestion cannot read
 * must still be one the adaptive engine can run on, so the three schemas never validate each other.
 */
export function ingestionParams(overrides: Record<string, unknown> = {}): IngestionParams {
  const parsed = parseIngestionParams(merge(SEED_ENGINE_PARAMS, overrides));
  if (!parsed.ok) throw new Error(`test ingestion params are invalid: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}
