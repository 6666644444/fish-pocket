// The model's way into the question bank (M4): one tool, `learning_quiz`, offered only in
// sessions the app started in a learning mode (index.mjs `when`). The quiz skill
// (engine/skills/learning-quiz) tells the model to save each question before asking it and
// to grade each answer with it, so questions are kept, graded in Node, and answers the
// learner gets wrong land in the mistake book the app shows.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { KINDS, MASTERY, QUIZ_LIMITS, letter } from './quiz.mjs';
import { plain } from './wire.mjs';

export const TOOL = 'learning_quiz';

const DESCRIPTION = 'The learner\'s question bank. In a quiz: `save` each question before you ask it (you get its id), '
  + 'and when the learner answers, `grade` that id with their answer exactly as they gave it. Grading is done here: a '
  + 'multiple-choice answer is checked against the saved option; a short answer is compared with the saved reference, '
  + 'and you may pass your own `judged` verdict when you can tell from the meaning. Use the result to tell the learner '
  + `whether they were right, then explain. Wrong answers go into their mistake book and leave it after ${MASTERY} `
  + 'correct answers in a row. `list` shows saved questions (with `mistakes: true`, the mistake book) for a review round. '
  + 'Never show the saved answer before the learner has answered.';

export function quizTool(open) {
  return defineTool({
    name: TOOL,
    description: DESCRIPTION,
    parameters: {
      action: { type: 'string', enum: ['save', 'grade', 'list'], description: 'save questions, grade an answer, or list questions', required: true },
      questions: {
        type: 'array',
        description: `save: 1 to ${QUIZ_LIMITS.batch} questions`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: KINDS, description: 'choice (multiple choice) or short (short answer)', required: true },
            prompt: { type: 'string', description: 'the question as the learner sees it, without the options', required: true },
            options: { type: 'array', items: { type: 'string' }, description: 'choice: 2 to 6 options, without letters' },
            answer: { type: 'string', description: 'choice: the correct option letter (A, B, …); short: the reference answer', required: true },
            explanation: { type: 'string', description: 'why the answer is right, shown after grading' },
            topic: { type: 'string', description: 'a short topic name, the same for questions on the same subject' },
          },
        },
      },
      questionId: { type: 'number', description: 'grade: the id `save` returned' },
      answer: { type: 'string', description: 'grade: the learner\'s answer, as given' },
      judged: { type: 'string', enum: ['correct', 'partial', 'incorrect'], description: 'grade, short answers only: your verdict from the meaning' },
      topic: { type: 'string', description: 'list: only this topic' },
      mistakes: { type: 'boolean', description: 'list: only questions in the mistake book' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => [{ type: 'text', text: render(args.action, value) }],
    },
    // Every result as lossless JSON (wire.mjs): one undefined field fails the whole call.
    execute: async (args, exec) => plain(await run(args, exec)),
  });

  async function run(args, exec) {
    const store = open();
    if (args.action === 'save') {
      const sessionId = exec?.agent?.session?.id;
      const saved = store.saveQuestions({ questions: args.questions ?? [], sessionId: typeof sessionId === 'string' ? sessionId : undefined });
      return { saved: saved.map((q) => ({ id: q.id, kind: q.kind, options: q.options.length })) };
    }
    if (args.action === 'grade') {
      if (!Number.isInteger(args.questionId)) throw new Error(`${TOOL}: grade needs the questionId that save returned`);
      if (typeof args.answer !== 'string' || !args.answer.trim()) throw new Error(`${TOOL}: grade needs the learner's answer`);
      return store.answerQuestion({ id: args.questionId, answer: args.answer, judged: args.judged });
    }
    const questions = store.listQuestions({ topic: args.topic, mistakes: args.mistakes === true, limit: 20 });
    return { questions: questions.map((q) => ({ id: q.id, kind: q.kind, prompt: q.prompt, options: q.options, topic: q.topic, inMistakes: q.inMistakes })) };
  }
}

function render(action, value) {
  if (action === 'save') return `Saved: ${value.saved.map((q) => `#${q.id} (${q.kind})`).join(', ')}. Ask the learner now; do not reveal the answer.`;
  if (action === 'grade') {
    const book = value.mistakeBook === 'added' ? 'It is now in the mistake book.'
      : value.mistakeBook === 'removed' ? `It left the mistake book (${value.mastery} right in a row).`
        : value.mistakeBook === 'in' ? `Still in the mistake book (${value.streak}/${value.mastery} right in a row).` : '';
    const chosen = value.chosen ? ` (chose ${value.chosen})` : '';
    return `#${value.questionId}: ${value.verdict}${chosen}, score ${value.score}, graded by ${value.gradedBy}. `
      + `Correct answer: ${value.correctAnswer}.${value.explanation ? ` Explanation: ${value.explanation}` : ''} ${book}`.trim();
  }
  if (!value.questions.length) return 'No questions saved yet.';
  return value.questions.map((q) => `#${q.id} [${q.topic || '—'}] ${q.prompt}`
    + (q.options.length ? `\n${q.options.map((o, i) => `  ${letter(i)}. ${o}`).join('\n')}` : '')).join('\n');
}
