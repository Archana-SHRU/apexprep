/**
 * Reading the answer the server revealed.
 *
 * `revealedAnswer` arrives on the response to a submitted attempt — never before it — and its shape depends on
 * the question type: `{ optionKeys }` for option questions, `{ value, tolerance, mode }` for numeric ones,
 * `{ matrix }` for matrix-match, `{}` for long-form, which is marked by a human. The backend types it as an
 * open object, so these readers check rather than cast, and return null when the field is not what was
 * expected instead of rendering `undefined` at a learner.
 */
import type { Question } from '@/types'

export function revealedOptionKeys(revealed: Record<string, unknown> | undefined): string[] {
  const keys = revealed?.optionKeys
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []
}

function revealedValue(revealed: Record<string, unknown> | undefined): string | null {
  const value = revealed?.value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string' && value.trim() !== '') return value
  return null
}

/**
 * The correct answer as one short string for the verdict row, or null when there is nothing to show.
 *
 * Long-form answers legitimately have none: they are recorded `ungraded` and reviewed, so the panel says so
 * rather than displaying an empty value.
 */
export function revealedAnswerText(q: Question, revealed: Record<string, unknown> | undefined): string | null {
  if (!revealed) return null
  switch (q.type) {
    case 'single_correct':
    case 'multi_correct':
    case 'assertion_reason': {
      const keys = revealedOptionKeys(revealed)
      return keys.length === 0 ? null : keys.join(', ')
    }
    case 'integer':
    case 'numeric': {
      const value = revealedValue(revealed)
      if (value === null) return null
      const tolerance = revealed.tolerance
      // A tolerance of zero is a real answer ("exactly this"), so only a positive one is worth showing.
      return typeof tolerance === 'number' && tolerance > 0 ? `${value} ± ${tolerance}` : value
    }
    case 'matrix_match': {
      const matrix = revealed.matrix
      if (typeof matrix !== 'object' || matrix === null) return null
      const pairs = Object.entries(matrix as Record<string, unknown>)
        .map(([left, right]) => `${left} → ${Array.isArray(right) ? right.join('') : String(right)}`)
      return pairs.length === 0 ? null : pairs.join('; ')
    }
    case 'long_form':
      return null
  }
}

export function studentAnswerText(q: Question, a: { selectedKeys: string[]; value?: string; text?: string; matrix?: Record<string, string[]> }): string | null {
  switch (q.type) {
    case 'single_correct':
    case 'multi_correct':
    case 'assertion_reason':
      return a.selectedKeys.length === 0 ? null : [...a.selectedKeys].sort().join(', ')
    case 'integer':
    case 'numeric':
      return (a.value ?? '').trim() || null
    case 'long_form':
      return (a.text ?? '').trim() || null
    case 'matrix_match': {
      if (!a.matrix) return null
      const pairs = Object.entries(a.matrix)
        .filter(([, right]) => Array.isArray(right) && right.length > 0)
        .sort(([k1], [k2]) => k1.localeCompare(k2))
        .map(([left, right]) => `${left} → ${[...right].sort().join('')}`)
      return pairs.length === 0 ? null : pairs.join('; ')
    }
  }
}

/** The human-readable name of a question type, for the session strip. */
export const QUESTION_TYPE_LABELS: Record<Question['type'], string> = {
  single_correct: 'Single Correct Option',
  multi_correct: 'Multiple Correct Options',
  integer: 'Integer Answer',
  numeric: 'Numerical Response',
  assertion_reason: 'Assertion & Reason',
  matrix_match: 'Matrix Match',
  long_form: 'Long Answer',
}
