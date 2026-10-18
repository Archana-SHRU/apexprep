import { is } from 'drizzle-orm';
import { Column } from 'drizzle-orm';
import {
  FORBIDDEN_OPTION_COLUMNS,
  FORBIDDEN_QUESTION_COLUMNS,
  STUDENT_OPTION_COLUMNS,
  STUDENT_QUESTION_COLUMNS,
  toStudentQuestionView,
  type StudentOptionRow,
  type StudentQuestionRow,
} from '../../src/questions/student-question.view';

const columnNames = (projection: Record<string, unknown>): string[] =>
  Object.values(projection)
    .filter((v): v is Column => is(v, Column))
    .map((c) => c.name)
    .sort();

describe('student question projection', () => {
  it('selects only these columns of questions', () => {
    expect(columnNames(STUDENT_QUESTION_COLUMNS)).toEqual(
      ['difficulty_label', 'expected_time_seconds', 'id', 'primary_subtopic_id', 'stem', 'stem_json', 'type', 'version'].sort(),
    );
  });

  it('selects only the key, side and text of options', () => {
    expect(columnNames(STUDENT_OPTION_COLUMNS)).toEqual(['body', 'option_key', 'side'].sort());
  });

  it('contains no answer column, engine difficulty or hint text', () => {
    const selected = [...columnNames(STUDENT_QUESTION_COLUMNS), ...columnNames(STUDENT_OPTION_COLUMNS)];
    for (const forbidden of [...FORBIDDEN_QUESTION_COLUMNS, ...FORBIDDEN_OPTION_COLUMNS]) {
      expect(selected).not.toContain(forbidden);
    }
  });
});

describe('toStudentQuestionView', () => {
  const question: StudentQuestionRow = {
    id: 'q1',
    version: 3,
    type: 'single_correct',
    subtopicId: 'st1',
    stem: 'What is I for a ring?',
    stemJson: null,
    difficultyLabel: 2,
    expectedTimeSeconds: 60,
    hintCount: 2,
  };
  const options: StudentOptionRow[] = [
    { key: 'A', side: 'single', text: 'MR²' },
    { key: 'B', side: 'single', text: '½MR²' },
  ];

  it('returns options as key and text only, with no extra keys', () => {
    const view = toStudentQuestionView(question, options);
    expect(Object.keys(view).sort()).toEqual(
      ['difficultyLabel', 'expectedTimeSeconds', 'hintCount', 'id', 'options', 'stem', 'stemJson', 'subtopicId', 'type', 'version'].sort(),
    );
    expect(view.options).toEqual([
      { key: 'A', text: 'MR²' },
      { key: 'B', text: '½MR²' },
    ]);
    expect(view.matrix).toBeUndefined();
  });

  it('splits matrix_match options into left and right columns', () => {
    const view = toStudentQuestionView({ ...question, type: 'matrix_match' }, [
      { key: 'A', side: 'left', text: 'left A' },
      { key: 'p', side: 'right', text: 'right p' },
    ]);
    expect(view.options).toEqual([]);
    expect(view.matrix).toEqual({ left: [{ key: 'A', text: 'left A' }], right: [{ key: 'p', text: 'right p' }] });
  });
});
