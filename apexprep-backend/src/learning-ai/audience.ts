/**
 * Who the learner is, in words a prompt can use — derived from the track's own metadata (migration 0013),
 * never from a hardcoded list of exams.
 *
 * A Class 2 learner and a JEE Advanced aspirant need the same fact explained very differently, so every
 * learning-AI prompt carries this line. It changes wording and depth only: difficulty is the adaptive
 * engine's business, and `grade_ordinal` is still never read as a difficulty (B66).
 */
export interface AudienceTrack {
  name: string;
  kind: string | null;
  gradeLabel: string | null;
  gradeOrdinal: number | null;
  examFamily: string | null;
}

export function audienceFor(track: AudienceTrack): string {
  if (track.kind === 'school' && track.gradeOrdinal !== null) {
    const label = track.gradeLabel ?? track.name;
    if (track.gradeOrdinal <= 5) {
      return `a young school student in ${label}. Use very short sentences, everyday words and concrete objects (apples, coins, blocks). No jargon, no algebra unless the notes use it.`;
    }
    if (track.gradeOrdinal <= 10) {
      return `a school student in ${label}. Use clear, simple language, define every technical term the first time, and prefer worked examples.`;
    }
    return `a senior school student in ${label}. Use precise subject vocabulary and standard notation.`;
  }
  if (track.kind === 'olympiad') {
    return `a student preparing for the ${track.name}. Be rigorous and precise; this student can handle depth.`;
  }
  if (track.kind === 'competitive_exam') {
    return `a student preparing for ${track.examFamily ? `${track.name} (${track.examFamily})` : track.name}. Be precise and exam-focused.`;
  }
  return `a student on the "${track.name}" track. Use clear, precise language.`;
}
