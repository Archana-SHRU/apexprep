/** One valid create payload per question type, shared by the question-bank and leakage suites. */
export const SECRET_NUMERIC = '7331.5';
export const SECRET_INTEGER = '424242';

export interface QuestionSample {
  type: string;
  payload: Record<string, unknown>;
  /** Strings that must never appear in a student payload for this question. */
  secrets: string[];
}

export function questionSamples(subtopicId: string): QuestionSample[] {
  const base = { subtopicId, difficultyLabel: 2, expectedTimeSeconds: 60 };
  return [
    {
      type: 'single_correct',
      payload: {
        ...base,
        type: 'single_correct',
        stem: 'Moment of inertia of a thin ring about its central axis?',
        hints: ['Every element is at distance R.'],
        options: [
          { key: 'A', text: 'MR squared', isCorrect: true },
          { key: 'B', text: 'half MR squared' },
          { key: 'C', text: 'two fifths MR squared' },
          { key: 'D', text: 'two thirds MR squared' },
        ],
      },
      secrets: ['Every element is at distance R.'],
    },
    {
      type: 'multi_correct',
      payload: {
        ...base,
        type: 'multi_correct',
        stem: 'Which statements about rolling without slipping are true?',
        options: [
          { key: 'A', text: 'The contact point is instantaneously at rest', isCorrect: true },
          { key: 'B', text: 'v equals omega R', isCorrect: true },
          { key: 'C', text: 'Friction does work on the body' },
          { key: 'D', text: 'Angular momentum about the centre is conserved while slipping' },
        ],
      },
      secrets: [],
    },
    {
      type: 'assertion_reason',
      payload: {
        ...base,
        type: 'assertion_reason',
        stem: 'Assertion: a rolling ring has more kinetic energy than a sliding one. Reason: rotation adds energy.',
        options: [
          { key: 'A', text: 'Both true, reason explains assertion', isCorrect: true },
          { key: 'B', text: 'Both true, reason does not explain assertion' },
          { key: 'C', text: 'Assertion true, reason false' },
          { key: 'D', text: 'Assertion false' },
        ],
      },
      secrets: [],
    },
    {
      type: 'integer',
      payload: {
        ...base,
        type: 'integer',
        stem: 'A disc of I = 4 kg m² under a torque of 8 N m has what angular acceleration, in rad/s²?',
        numericAnswer: { value: SECRET_INTEGER },
      },
      secrets: [SECRET_INTEGER],
    },
    {
      type: 'numeric',
      payload: {
        ...base,
        type: 'numeric',
        stem: 'Find the angular speed after one second (rad/s).',
        numericAnswer: { value: SECRET_NUMERIC, tolerance: '0.05', mode: 'absolute' },
      },
      secrets: [SECRET_NUMERIC, '0.05'],
    },
    {
      type: 'matrix_match',
      payload: {
        ...base,
        type: 'matrix_match',
        stem: 'Match each body with its moment of inertia about the central axis.',
        options: [
          { key: 'A', text: 'Thin ring', side: 'left' },
          { key: 'B', text: 'Solid sphere', side: 'left' },
          { key: 'p', text: 'two fifths MR squared', side: 'right' },
          { key: 'q', text: 'MR squared', side: 'right' },
        ],
        matrixAnswer: { A: ['q'], B: ['p'] },
      },
      secrets: [],
    },
    {
      type: 'long_form',
      payload: {
        ...base,
        type: 'long_form',
        stem: 'Derive the acceleration of a cylinder rolling down an incline of angle θ.',
      },
      secrets: [],
    },
  ];
}
