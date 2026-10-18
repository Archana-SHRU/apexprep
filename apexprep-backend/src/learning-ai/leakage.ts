import { normalizeMath } from '../common/learning/math-text';
import type { QuestionType } from '../database/schema';

/**
 * Deterministic answer-leak detection, run on AI output that a student sees **before** they have
 * answered (tutor hints, visual explanations, the stem and hints of a generated question).
 *
 * The model is told not to reveal the answer; this is the check that it did not. It works from the
 * question's authoritative answer key — the same record students are graded from — so a model cannot
 * talk its way past it. It is deliberately conservative: a false positive costs one regeneration or a
 * safe fallback, a false negative gives the answer away.
 *
 * Pure: no database, no configuration.
 */

export interface LeakAnswer {
  type: QuestionType;
  /** Option keys marked correct (option types only). */
  correctOptionKeys: readonly string[];
  /** The question's single-side options, key and text. */
  options: readonly { key: string; text: string }[];
  /** The exact decimal answer for integer/numeric questions. */
  correctNumeric: string | null;
  /** The question stem: anything already stated there is not a leak. */
  stem: string;
}

export type LeakRule = 'answer_phrase' | 'option_key' | 'option_text' | 'numeric_value';

export interface Leak {
  rule: LeakRule;
  detail: string;
}

const OPTION_TYPES: readonly QuestionType[] = ['single_correct', 'multi_correct', 'assertion_reason'];

/** Lowercase, punctuation to spaces, whitespace collapsed. */
export function normalizeText(text: string): string {
  // Notation first: "$\frac{2}{3}MRv$" in an option and "2/3 MRv" in a reply must compare as the same thing.
  return normalizeMath(text)
    .toLowerCase()
    .normalize('NFKC')
    // A full stop is kept only as a decimal point: sentence punctuation must not stop "…the contact point."
    // from matching the option text "…the contact point".
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/[^\p{L}\p{N}.%/+\-=^]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every number written in a text, as a JS number, with how it was written. */
function numbersIn(text: string): { raw: string; value: number }[] {
  const out: { raw: string; value: number }[] = [];
  for (const match of text.matchAll(/(?<![\p{L}\d.])-?\d+(?:\.\d+)?/gu)) {
    const value = Number(match[0]);
    if (Number.isFinite(value)) out.push({ raw: match[0], value });
  }
  return out;
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** The leading number of an option like "12.5 m/s", when the option is essentially a number. */
function numericOptionValue(text: string): number | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*([\p{L}/%°^0-9\s]{0,12})$/u.exec(text);
  return match ? Number(match[1]) : null;
}

const ANSWER_PHRASES: readonly RegExp[] = [
  /\b(?:the\s+)?(?:correct|right|final)\s+(?:answer|option|choice)\s+(?:is|would\s+be|will\s+be|=|:)/i,
  /\banswer\s*(?:is|=|:)\s*\S/i,
  /\bso\s+the\s+answer\b/i,
];

export function findAnswerLeaks(text: string, answer: LeakAnswer): Leak[] {
  const leaks: Leak[] = [];
  if (text.trim().length === 0) return leaks;

  for (const pattern of ANSWER_PHRASES) {
    if (pattern.test(text)) {
      leaks.push({ rule: 'answer_phrase', detail: 'states what the answer is' });
      break;
    }
  }

  const stemNumbers = numbersIn(answer.stem).map((n) => n.value);
  const normalizedStem = normalizeText(answer.stem);

  if (OPTION_TYPES.includes(answer.type)) {
    for (const key of answer.correctOptionKeys) {
      const k = escapeRegExp(key);
      const patterns = [
        new RegExp(`\\b(?:option|choice|answer)\\s*[([]?\\s*${k}\\s*[)\\]]?(?![A-Za-z0-9])`, 'i'),
        new RegExp(`[([]\\s*${k}\\s*[)\\]]\\s*(?:is|are)\\s+(?:the\\s+)?(?:correct|right|true|answer)`, 'i'),
        new RegExp(`(?<![A-Za-z0-9])${k}\\s+is\\s+(?:the\\s+)?(?:correct|right)\\b`, 'i'),
      ];
      if (patterns.some((p) => p.test(text))) leaks.push({ rule: 'option_key', detail: `names the correct option ${key}` });

      const option = answer.options.find((o) => o.key === key);
      if (!option) continue;
      const numeric = numericOptionValue(option.text);
      if (numeric !== null) {
        if (!stemNumbers.some((n) => sameNumber(n, numeric)) && mentionsNumber(text, numeric)) {
          leaks.push({ rule: 'numeric_value', detail: `states the value of the correct option ${key}` });
        }
        continue;
      }
      const optionText = normalizeText(option.text);
      // Short or generic option texts ("yes", "zero") are not evidence of anything on their own.
      if (optionText.length < 4 || normalizedStem.includes(optionText)) continue;
      const wrongOptionsContainIt = answer.options.some((o) => o.key !== key && !answer.correctOptionKeys.includes(o.key) && normalizeText(o.text).includes(optionText));
      if (wrongOptionsContainIt) continue;
      const normalizedReply = normalizeText(text);
      if (new RegExp(`(?:^|\\s)${escapeRegExp(optionText)}(?:\\s|$)`).test(normalizedReply)) {
        leaks.push({ rule: 'option_text', detail: `repeats the text of the correct option ${key}` });
        continue;
      }
      // A formula-like option ("2/3 MRv") may be written with different spacing ("2/3MRv"): compare it without
      // spaces. Only for options that look like mathematics, where spacing carries no meaning.
      const compactOption = optionText.replace(/\s+/g, '');
      if (/[\d/^=+]/.test(optionText) && compactOption.length >= 4 && !normalizedStem.replace(/\s+/g, '').includes(compactOption)) {
        if (normalizedReply.replace(/\s+/g, '').includes(compactOption)) {
          leaks.push({ rule: 'option_text', detail: `states the formula of the correct option ${key}` });
        }
      }
    }
  }

  if ((answer.type === 'integer' || answer.type === 'numeric') && answer.correctNumeric !== null) {
    const value = Number(answer.correctNumeric);
    if (Number.isFinite(value) && !stemNumbers.some((n) => sameNumber(n, value)) && mentionsNumber(text, value)) {
      leaks.push({ rule: 'numeric_value', detail: 'states the numeric answer' });
    }
  }

  return leaks;
}

/**
 * Whether a text states this value. Large or non-integer values are distinctive, so any occurrence
 * counts. A small integer turns up everywhere ("step 2", "2 forces"), so for those only an
 * answer-like statement counts: "= 4", "is 4", "equals 4", "gives 4".
 */
function mentionsNumber(text: string, value: number): boolean {
  const smallInteger = Number.isInteger(value) && Math.abs(value) <= 10;
  if (!smallInteger) return numbersIn(text).some((n) => sameNumber(n.value, value));
  const literal = escapeRegExp(String(value));
  return new RegExp(`(?:=|≈|\\bequals?\\b|\\bis\\b|\\bgives?\\b|\\bcomes\\s+to\\b|\\bbecomes\\b|\\bget\\b)\\s*${literal}(?!\\d|\\.\\d)`, 'i').test(text);
}
