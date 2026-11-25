// The question bank (M4): questions the model writes in a quiz session, saved through the
// `learning_quiz` tool (index.mjs), graded here, with a mistake book that a question leaves
// after it is answered right `MASTERY` times in a row.
//
// Pure logic, no I/O: validation, grading and the mistake-book rule. The tables are in
// store.mjs (schema 5).

export const KINDS = ['choice', 'short'];

/** Correct answers in a row that take a question out of the mistake book (DECISIONS.md D21). */
export const MASTERY = 2;

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
 * The mistake book after one graded answer. Anything short of correct puts the question in
 * (again) with its streak reset; a correct answer to a question in the book adds one to the
 * streak, and `MASTERY` in a row takes it out. A correct answer to a question not in the
 * book changes nothing.
 * @param {{ streak:number } | null} entry - the question's mistake-book row, or null.
 * @returns {{ action:'add'|'reset'|'progress'|'remove'|'none', streak:number }}
 */
export function nextMistake(entry, verdict, mastery = MASTERY) {
  if (verdict !== 'correct') return { action: entry ? 'reset' : 'add', streak: 0 };
  if (!entry) return { action: 'none', streak: 0 };
  const streak = entry.streak + 1;
  return streak >= mastery ? { action: 'remove', streak } : { action: 'progress', streak };
}
