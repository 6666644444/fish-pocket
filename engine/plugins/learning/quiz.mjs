// The question bank (M4): questions the model writes in a quiz session, saved through the
// `learning_quiz` tool (index.mjs), graded here, with a mistake book that a question leaves
// after it is answered right `MASTERY` times in a row.
//
// Pure logic, no I/O: validation, grading and the mistake-book rule. The tables are in
// store.mjs (schema 5; review dates schema 9).

export const KINDS = ['choice', 'short'];

/**
 * Days from a mistake-book answer to the question's next review, by the run of correct
 * answers it has (D53): a wrong answer comes back the next day, then after 3 and 7 days.
 * Spacing the reviews out is what tells remembering from having just seen the answer.
 */
export const REVIEW_DAYS = [1, 3, 7];

/** Correct answers in a row, each on or after its review day, that take a question out of the mistake book (D21, D53). */
export const MASTERY = REVIEW_DAYS.length;

export const DAY_MS = 86_400_000;

/** Start of the local day `ms` falls in, `tzOffset` minutes east of UTC (UTC+8 → 480). */
export function dayStart(ms, tzOffset = 0) {
  const shift = tzOffset * 60_000;
  return Math.floor((ms + shift) / DAY_MS) * DAY_MS - shift;
}

/**
 * Short answers: the share of the reference's key terms the answer must contain to count as
 * correct, and below which it is incorrect; in between it is `partial` (D20).
 */
export const SHORT_GRADING = { correct: 0.7, partial: 0.3 };

export const QUIZ_LIMITS = { prompt: 2_000, option: 500, options: 6, answer: 2_000, explanation: 4_000, topic: 100, batch: 20 };

const codepoints = (text) => [...text].length;

export class QuizError extends Error {
  constructor(message) {
    super(message);
    this.kind = 'invalid';
  }
}

function str(value, field, max, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new QuizError(`${field} is empty`);
    return '';
  }
  if (typeof value !== 'string') throw new QuizError(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new QuizError(`${field} is empty`);
  if (codepoints(trimmed) > max) throw new QuizError(`${field} is longer than ${max} characters`);
  return trimmed;
}

/** Letter of option `index` (0 → A). */
export const letter = (index) => String.fromCharCode(65 + index);

/**
 * A question as stored. choice: 2–6 distinct options and `answer` the correct option's
 * letter (A…) or its 0-based index. short: `answer` is the reference answer.
 * @returns {{kind:string, prompt:string, options:string[], answer:string, explanation:string, topic:string}}
 */
export function normalizeQuestion(input) {
  if (!input || typeof input !== 'object') throw new QuizError('a question must be an object');
  const kind = input.kind;
  if (!KINDS.includes(kind)) throw new QuizError(`kind must be one of ${KINDS.join(', ')}`);
  const prompt = str(input.prompt, 'prompt', QUIZ_LIMITS.prompt);
  const explanation = str(input.explanation, 'explanation', QUIZ_LIMITS.explanation, { required: false });
  const topic = str(input.topic, 'topic', QUIZ_LIMITS.topic, { required: false });
  if (kind === 'choice') {
    if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > QUIZ_LIMITS.options) {
      throw new QuizError(`a choice question needs 2 to ${QUIZ_LIMITS.options} options`);
    }
    const options = input.options.map((option, i) => str(option, `options[${i}]`, QUIZ_LIMITS.option)
      // "A. foo" / "A) foo" / "A、foo": the letter is ours to add.
      .replace(/^[A-Fa-f][.)、．:：]\s*/u, ''));
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new QuizError('options must be different from each other');
    const index = choiceIndex(input.answer, options.length);
    if (index === null) throw new QuizError(`answer must be the correct option's letter (A–${letter(options.length - 1)})`);
    return { kind, prompt, options, answer: letter(index), explanation, topic };
  }
  if (input.options !== undefined && (!Array.isArray(input.options) || input.options.length)) {
    throw new QuizError('a short-answer question has no options');
  }
  return { kind, prompt, options: [], answer: str(input.answer, 'answer', QUIZ_LIMITS.answer), explanation, topic };
}

/** "B", "b", "B.", "(B)", " 选 B ", 1 → index; null when it names no option. */
export function choiceIndex(value, count) {
  if (Number.isInteger(value)) return value >= 0 && value < count ? value : null;
  if (typeof value !== 'string') return null;
  const letters = value.toUpperCase().match(/(?<![A-Z])[A-F](?![A-Z])/g);
  if (!letters || new Set(letters).size !== 1) return null;
  const index = letters[0].charCodeAt(0) - 65;
  return index < count ? index : null;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'is', 'are', 'and', 'or', 'in', 'on', 'it', 'that', 'this', 'be', 'by', 'for', 'as', 'with']);

/** Normalised text for exact comparison: NFKC, lower case, no spaces or punctuation. */
export function normalizeAnswer(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Key terms: Latin words and numbers (no stop words); for CJK, every pair of neighbours. */
export function keyTerms(text) {
  const terms = new Set();
  for (const run of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}.]+/gu) ?? []) {
    const chars = [...run];
    let latin = '';
    const flush = () => {
      const word = latin.replace(/^\.+|\.+$/g, '');
      if (word && !STOP.has(word) && (word.length >= 2 || /\d/.test(word))) terms.add(word);
      latin = '';
    };
    for (let i = 0; i < chars.length; i += 1) {
      if (CJK.test(chars[i])) {
        flush();
        if (i + 1 < chars.length && CJK.test(chars[i + 1])) terms.add(chars[i] + chars[i + 1]);
        else if (!(i > 0 && CJK.test(chars[i - 1]))) terms.add(chars[i]);
      } else {
        latin += chars[i];
      }
    }
    flush();
  }
  return terms;
}

/**
 * Grade one answer. choice: right or wrong by the option chosen. short: an answer that
 * matches the reference once normalised is correct; otherwise the share of the reference's
 * key terms it contains decides correct / partial / incorrect (SHORT_GRADING). The model
 * may pass its own verdict for a short answer (`judged`), which then decides: it reads
 * meaning, which term overlap cannot.
 * @returns {{ verdict:'correct'|'partial'|'incorrect', score:number, gradedBy:'rule'|'model', chosen?:string }}
 */
export function grade(question, answer, { judged } = {}) {
  if (typeof answer !== 'string' && !Number.isInteger(answer)) throw new QuizError('answer must be a string');
  if (question.kind === 'choice') {
    const index = choiceIndex(answer, question.options.length);
    if (index === null) throw new QuizError(`answer with one option letter, A–${letter(question.options.length - 1)}`);
    const correct = letter(index) === question.answer;
    return { verdict: correct ? 'correct' : 'incorrect', score: correct ? 1 : 0, gradedBy: 'rule', chosen: letter(index) };
  }
  const text = String(answer).trim();
  if (!text) throw new QuizError('answer is empty');
  if (judged !== undefined) {
    if (!['correct', 'partial', 'incorrect'].includes(judged)) throw new QuizError('judged must be correct, partial or incorrect');
    return { verdict: judged, score: judged === 'correct' ? 1 : judged === 'partial' ? 0.5 : 0, gradedBy: 'model' };
  }
  if (normalizeAnswer(text) === normalizeAnswer(question.answer)) return { verdict: 'correct', score: 1, gradedBy: 'rule' };
  const reference = keyTerms(question.answer);
  if (!reference.size) return { verdict: 'incorrect', score: 0, gradedBy: 'rule' };
  const given = keyTerms(text);
  let hit = 0;
  for (const term of reference) if (given.has(term)) hit += 1;
  const score = Number((hit / reference.size).toFixed(3));
  const verdict = score >= SHORT_GRADING.correct ? 'correct' : score >= SHORT_GRADING.partial ? 'partial' : 'incorrect';
  return { verdict, score, gradedBy: 'rule' };
}

/**
 * The mistake book after one graded answer (D53). Anything short of correct puts the question
 * in (again) with its streak reset, due the next local day. A correct answer to a question in
 * the book on or after its review day adds one to the streak and sets the next review
 * (`REVIEW_DAYS`); `mastery` in a row take it out. A correct answer before the review day
 * counts for nothing (`early`): the answer was still fresh. `counts: true` (the learner
 * overruling a grade) takes a correct answer as on time. A correct answer to a question not
 * in the book changes nothing.
 * @param {{ streak:number, dueAt?:number|null } | null} entry - the question's mistake-book row, or null.
 * @param {{ now?:number, tzOffset?:number, mastery?:number, counts?:boolean }} [options]
 * @returns {{ action:'add'|'reset'|'progress'|'remove'|'early'|'none', streak:number, dueAt?:number }}
 */
export function nextMistake(entry, verdict, { now = 0, tzOffset = 0, mastery = MASTERY, counts = false } = {}) {
  const due = (days) => dayStart(now, tzOffset) + days * DAY_MS;
  if (verdict !== 'correct') return { action: entry ? 'reset' : 'add', streak: 0, dueAt: due(REVIEW_DAYS[0]) };
  if (!entry) return { action: 'none', streak: 0 };
  if (!counts && Number.isFinite(entry.dueAt) && entry.dueAt > now) return { action: 'early', streak: entry.streak, dueAt: entry.dueAt };
  const streak = entry.streak + 1;
  if (streak >= mastery) return { action: 'remove', streak };
  return { action: 'progress', streak, dueAt: due(REVIEW_DAYS[Math.min(streak, REVIEW_DAYS.length - 1)]) };
}
