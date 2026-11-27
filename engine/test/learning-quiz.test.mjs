import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import Learning, { ROUTE } from '../plugins/learning/index.mjs';
import {
  DAY_MS, MASTERY, REVIEW_DAYS, SHORT_GRADING, choiceIndex, dayStart, grade, keyTerms, nextMistake, normalizeAnswer, normalizeQuestion,
} from '../plugins/learning/quiz.mjs';

/** 2026-11-27 01:00 UTC: 09:00 in China, still the 26th in California. */
const T0 = Date.UTC(2026, 10, 27, 1);
import { TOOL } from '../plugins/learning/quiz-tool.mjs';
import { APPLICATION_ID, LearningStore, MIGRATIONS, SCHEMA_VERSION } from '../plugins/learning/store.mjs';

const choice = { kind: 'choice', prompt: '2 + 2 = ?', options: ['3', '4', '5', '22'], answer: 'B', explanation: '2 加 2 等于 4', topic: '算术' };
const short = { kind: 'short', prompt: '导数的几何意义是什么？', answer: '函数图像在该点切线的斜率', topic: '微积分' };

// Validation

test('a choice question: letters stripped from options, answer stored as a letter', () => {
  const q = normalizeQuestion({ ...choice, options: ['A. 3', 'B) 4', 'C、5', '22'], answer: 1 });
  assert.deepEqual(q.options, ['3', '4', '5', '22']);
  assert.equal(q.answer, 'B');
  assert.equal(normalizeQuestion({ ...choice, answer: '(b)' }).answer, 'B');
});

test('bad questions are refused with a reason', () => {
  for (const [bad, why] of [
    [{ ...choice, kind: 'essay' }, /kind/],
    [{ ...choice, prompt: ' ' }, /prompt/],
    [{ ...choice, options: ['only'] }, /2 to 6/],
    [{ ...choice, options: ['1', '2', '3', '4', '5', '6', '7'] }, /2 to 6/],
    [{ ...choice, options: ['4', '4'] }, /different/],
    [{ ...choice, answer: 'E' }, /letter/],
    [{ ...choice, answer: 'A or B' }, /letter/],
    [{ ...short, answer: '' }, /answer/],
    [{ ...short, options: ['x'] }, /no options/],
    [null, /object/],
  ]) {
    assert.throws(() => normalizeQuestion(bad), why);
  }
  assert.deepEqual(normalizeQuestion({ ...short, options: [] }).options, []);
});

test('choiceIndex reads one option letter in common shapes', () => {
  assert.equal(choiceIndex('B', 4), 1);
  assert.equal(choiceIndex('b.', 4), 1);
  assert.equal(choiceIndex('我选 C', 4), 2);
  assert.equal(choiceIndex('(d)', 4), 3);
  assert.equal(choiceIndex(0, 4), 0);
  assert.equal(choiceIndex('E', 4), null);
  assert.equal(choiceIndex('A 或 B', 4), null);
  assert.equal(choiceIndex('BAD', 4), null, 'letters inside a word are not choices');
  assert.equal(choiceIndex('', 4), null);
});

// Grading

test('choice grading', () => {
  const q = normalizeQuestion(choice);
  assert.deepEqual(grade(q, 'B'), { verdict: 'correct', score: 1, gradedBy: 'rule', chosen: 'B' });
  assert.deepEqual(grade(q, 'a'), { verdict: 'incorrect', score: 0, gradedBy: 'rule', chosen: 'A' });
  assert.throws(() => grade(q, '4'), /option letter/);
  assert.throws(() => grade(q, 'C', { judged: 'correct' }) && grade(q, 'Z'), /option letter/);
  assert.equal(grade(q, 'C', { judged: 'correct' }).verdict, 'incorrect', 'a model verdict never overrides a choice');
});

test('short grading: normalised match, term overlap thresholds, the model verdict decides when given', () => {
  const q = normalizeQuestion(short);
  assert.equal(grade(q, '函数图像在该点切线的斜率。').verdict, 'correct');
  assert.equal(grade(q, '  函数图像，在该点 切线的斜率 ').verdict, 'correct', 'punctuation and spaces do not count');
  assert.equal(grade(q, '切线的斜率').verdict, 'partial');
  assert.equal(grade(q, '面积').verdict, 'incorrect');
  const english = normalizeQuestion({ kind: 'short', prompt: 'p', answer: 'The slope of the tangent line' });
  assert.equal(grade(english, 'slope of the tangent line').verdict, 'correct');
  assert.equal(grade(english, 'tangent').verdict, 'partial', 'one of three key terms');
  assert.equal(grade(english, 'banana').verdict, 'incorrect');
  assert.equal(grade(english, 'the TANGENT line slope').verdict, 'correct');
  assert.deepEqual(grade(q, '描述变化快慢的切线倾斜程度', { judged: 'correct' }), { verdict: 'correct', score: 1, gradedBy: 'model' });
  assert.equal(grade(q, 'x', { judged: 'partial' }).score, 0.5);
  assert.throws(() => grade(q, 'x', { judged: 'maybe' }), /judged/);
  assert.throws(() => grade(q, '  '), /empty/);
  assert.ok(SHORT_GRADING.correct > SHORT_GRADING.partial);
});

test('numbers count as key terms; normalisation is NFKC', () => {
  assert.ok(keyTerms('答案是 3.14').has('3.14'));
  assert.ok(keyTerms('x = 7').has('7'));
  assert.equal(normalizeAnswer('ＡＢＣ　１２３'), 'abc123');
  const q = normalizeQuestion({ kind: 'short', prompt: 'π 约等于？', answer: '3.14' });
  assert.equal(grade(q, '３．１４').verdict, 'correct');
  assert.equal(grade(q, '3.15').verdict, 'incorrect');
});

// The mistake-book rule

test('wrong answers go in due tomorrow, a wrong answer resets the streak, MASTERY right in a row on their review days take it out', () => {
  assert.deepEqual(REVIEW_DAYS, [1, 3, 7]);
  assert.equal(MASTERY, 3);
  const day = dayStart(T0, 0);
  const at = { now: T0, tzOffset: 0 };
  assert.deepEqual(nextMistake(null, 'correct', at), { action: 'none', streak: 0 });
  assert.deepEqual(nextMistake(null, 'incorrect', at), { action: 'add', streak: 0, dueAt: day + DAY_MS });
  assert.deepEqual(nextMistake(null, 'partial', at), { action: 'add', streak: 0, dueAt: day + DAY_MS }, 'partly right is not right');
  assert.deepEqual(nextMistake({ streak: 0, dueAt: T0 }, 'correct', at), { action: 'progress', streak: 1, dueAt: day + 3 * DAY_MS });
  assert.deepEqual(nextMistake({ streak: 1, dueAt: T0 - 5 }, 'correct', at), { action: 'progress', streak: 2, dueAt: day + 7 * DAY_MS });
  assert.deepEqual(nextMistake({ streak: 2, dueAt: T0 }, 'correct', at), { action: 'remove', streak: 3 });
  assert.deepEqual(nextMistake({ streak: 2, dueAt: T0 + 1 }, 'incorrect', at), { action: 'reset', streak: 0, dueAt: day + DAY_MS }, 'wrong counts any time');
  assert.deepEqual(nextMistake({ streak: 1, dueAt: T0 + 1 }, 'correct', at), { action: 'early', streak: 1, dueAt: T0 + 1 }, 'right too soon does not count');
  assert.deepEqual(nextMistake({ streak: 1, dueAt: T0 + 1 }, 'correct', { ...at, counts: true }).action, 'progress', 'an overruled grade counts');
  assert.deepEqual(nextMistake({ streak: 0, dueAt: null }, 'correct', at).action, 'progress', 'no review date: due');
  assert.deepEqual(nextMistake({ streak: 2, dueAt: T0 }, 'correct', { ...at, mastery: 4 }).streak, 3);
});

test('review days start at local midnight', () => {
  // 09:00 in China on the 27th: due at midnight starting the 28th, China time.
  assert.equal(nextMistake(null, 'incorrect', { now: T0, tzOffset: 480 }).dueAt, Date.UTC(2026, 10, 27, 16));
  // 17:00 on the 26th in California (UTC-8): due at midnight starting the 27th there.
  assert.equal(nextMistake(null, 'incorrect', { now: T0, tzOffset: -480 }).dueAt, Date.UTC(2026, 10, 27, 8));
  assert.equal(dayStart(Date.UTC(2026, 10, 27, 15, 59), 480), Date.UTC(2026, 10, 26, 16));
  assert.equal(dayStart(Date.UTC(2026, 10, 27, 16), 480), Date.UTC(2026, 10, 27, 16));
});

// The library

test('save, answer, the mistake book in and out on review days, attempts and topics', () => {
  let now = T0;
  const store = new LearningStore(':memory:', { now: () => now });
  const [c, s] = store.saveQuestions({ questions: [choice, short], sessionId: 'sess-1' });
  assert.equal(c.answer, 'B');
  assert.equal(c.sessionId, 'sess-1');
  assert.equal(s.kind, 'short');
  assert.equal(store.listQuestions()[0].answer, undefined, 'lists leave the answer out by default');
  assert.equal(store.listQuestions()[0].reviewAt, null);
  const day = dayStart(T0, 0);

  const wrong = store.answerQuestion({ id: c.id, answer: 'C', tzOffset: 0 });
  assert.deepEqual({ v: wrong.verdict, book: wrong.mistakeBook, streak: wrong.streak, due: wrong.dueAt }, { v: 'incorrect', book: 'added', streak: 0, due: day + DAY_MS });
  assert.equal(wrong.correctAnswer, 'B');
  assert.equal('early' in wrong, false);
  assert.deepEqual(store.listQuestions({ mistakes: true }).map((q) => [q.id, q.reviewAt]), [[c.id, day + DAY_MS]]);

  now += 60_000;
  const soon = store.answerQuestion({ id: c.id, answer: 'B' });
  assert.deepEqual({ book: soon.mistakeBook, streak: soon.streak, early: soon.early, due: soon.dueAt }, { book: 'in', streak: 0, early: true, due: day + DAY_MS }, 'the same day: does not count');

  now = day + DAY_MS + 3_600_000; // the review day
  const first = store.answerQuestion({ id: c.id, answer: 'B' });
  assert.deepEqual({ book: first.mistakeBook, streak: first.streak, due: first.dueAt, early: 'early' in first }, { book: 'in', streak: 1, due: day + 4 * DAY_MS, early: false });
  now += DAY_MS;
  const reset = store.answerQuestion({ id: c.id, answer: 'D' });
  assert.deepEqual({ streak: reset.streak, due: reset.dueAt }, { streak: 0, due: day + 3 * DAY_MS }, 'a wrong answer resets the run, due the next day');
  now = day + 3 * DAY_MS;
  assert.equal(store.answerQuestion({ id: c.id, answer: 'B' }).streak, 1);
  now += 3 * DAY_MS;
  assert.equal(store.answerQuestion({ id: c.id, answer: 'B' }).streak, 2);
  now += 6 * DAY_MS;
  assert.equal(store.answerQuestion({ id: c.id, answer: 'b' }).early, true, 'the 7-day review is not reached yet');
  now += DAY_MS;
  const out = store.answerQuestion({ id: c.id, answer: 'b' });
  assert.equal(out.mistakeBook, 'removed');
  assert.equal('dueAt' in out, false);
  assert.deepEqual(store.listQuestions({ mistakes: true }), []);
  assert.equal(store.answerQuestion({ id: c.id, answer: 'B' }).mistakeBook, 'not-in');

  assert.equal(store.listAttempts({ questionId: c.id }).length, 9);
  assert.deepEqual(store.listAttempts({ questionId: c.id })[0], { id: 9, answer: 'B', verdict: 'correct', score: 1, gradedBy: 'rule', createdAt: now });
  assert.deepEqual(store.getQuestion({ id: c.id }), { ...store.getQuestion({ id: c.id }), attempts: 9, lastVerdict: 'correct', inMistakes: false, reviewAt: null });

  store.answerQuestion({ id: s.id, answer: '面积' });
  assert.deepEqual(store.quizTopics(), [{ topic: '微积分', questions: 1, mistakes: 1 }, { topic: '算术', questions: 1, mistakes: 0 }]);
  assert.deepEqual(store.listQuestions({ topic: '微积分' }).map((q) => q.id), [s.id]);
  store.close();
});

test("today's review: what is due, how many, when the rest come due; the phone's zone is kept", () => {
  let now = T0;
  const store = new LearningStore(':memory:', { now: () => now });
  const [a, b, c] = store.saveQuestions({ questions: [choice, short, { ...choice, prompt: '1 + 1 = ?' }] });
  store.answerQuestion({ id: a.id, answer: 'A', tzOffset: 480 });
  assert.equal(store.tzOffset, 480, 'kept for the model, which sends no zone');
  store.answerQuestion({ id: b.id, answer: '面积' });
  const tomorrow = Date.UTC(2026, 10, 27, 16); // midnight starting the 28th, China time
  assert.deepEqual(store.reviewPlan(), { now, tzOffset: 480, due: 0, total: 2, dueTimes: [tomorrow, tomorrow], questions: [] });
  now = tomorrow + 1;
  store.answerQuestion({ id: c.id, answer: 'C' });
  const plan = store.reviewPlan({ tzOffset: 480 });
  assert.deepEqual({ due: plan.due, total: plan.total, ids: plan.questions.map((q) => q.id) }, { due: 2, total: 3, ids: [a.id, b.id] });
  assert.equal(plan.questions[0].answer, undefined, 'no answers before answering');
  assert.deepEqual(plan.dueTimes, [tomorrow, tomorrow, tomorrow + DAY_MS]);
  assert.deepEqual(store.listQuestions({ due: true }).map((q) => q.id), [a.id, b.id]);
  assert.throws(() => store.reviewPlan({ tzOffset: 1000 }), { kind: 'invalid' });
  assert.throws(() => store.reviewPlan({ tzOffset: 1.5 }), { kind: 'invalid' });
  store.close();
});

test('学习统计: answers per local day, days in a row, totals and topics', () => {
  let now = T0;
  const store = new LearningStore(':memory:', { now: () => now });
  const [a, b] = store.saveQuestions({ questions: [choice, short] });
  // Three days running, China time: the 25th, the 26th and the 27th.
  now = T0 - 2 * DAY_MS;
  store.answerQuestion({ id: a.id, answer: 'A', tzOffset: 480 });
  now = T0 - DAY_MS;
  store.answerQuestion({ id: a.id, answer: 'B' });
  now = T0;
  store.answerQuestion({ id: b.id, answer: '函数图像在该点切线的斜率' });
  store.answerQuestion({ id: a.id, answer: 'C' });
  const stats = store.learningStats({ tzOffset: 480, days: 7 });
  assert.equal(stats.days.length, 7);
  assert.deepEqual(stats.days.slice(-3).map((d) => [d.attempts, d.correct]), [[1, 0], [1, 1], [2, 1]]);
  assert.equal(stats.days.at(-1).day, Date.UTC(2026, 10, 26, 16), 'today starts at midnight China time');
  assert.equal(stats.streakDays, 3);
  assert.equal(stats.studiedToday, true);
  assert.deepEqual(
    { q: stats.totals.questions, n: stats.totals.attempts, ok: stats.totals.correct, book: stats.totals.mistakes, mastered: stats.totals.mastered },
    { q: 2, n: 4, ok: 2, book: 1, mastered: 0 },
  );
  assert.deepEqual(stats.topics, [
    { topic: '算术', questions: 1, attempts: 3, correct: 1, mistakes: 1 },
    { topic: '微积分', questions: 1, attempts: 1, correct: 1, mistakes: 0 },
  ]);
  // Nothing yet today does not break the run.
  now = T0 + DAY_MS;
  assert.deepEqual([store.learningStats().streakDays, store.learningStats().studiedToday], [3, false]);
  now = T0 + 2 * DAY_MS;
  assert.equal(store.learningStats().streakDays, 0);
  store.close();
});

test('the learner can overrule a grade; a batch with one bad question saves nothing', () => {
  const store = new LearningStore(':memory:');
  const [s] = store.saveQuestions({ questions: [short] });
  assert.equal(store.answerQuestion({ id: s.id, answer: '倾斜程度' }).mistakeBook, 'added');
  const overruled = store.answerQuestion({ id: s.id, answer: '倾斜程度', judged: 'correct', gradedBy: 'user' });
  assert.deepEqual({ v: overruled.verdict, by: overruled.gradedBy, book: overruled.mistakeBook }, { v: 'correct', by: 'user', book: 'in' });
  assert.throws(() => store.answerQuestion({ id: s.id, answer: 'x', gradedBy: 'model' }), { kind: 'invalid' });
  assert.throws(() => store.saveQuestions({ questions: [choice, { ...choice, answer: 'Z' }] }), /question 2/);
  assert.equal(store.listQuestions().length, 1);
  assert.throws(() => store.saveQuestions({ questions: [] }), { kind: 'invalid' });
  assert.throws(() => store.answerQuestion({ id: 999, answer: 'A' }), { kind: 'not-found' });
  assert.throws(() => store.answerQuestion({ id: s.id, answer: '' }), { kind: 'invalid' });
  assert.equal(store.listAttempts({ questionId: s.id }).length, 2, 'refused answers are not recorded');
  store.close();
});

test('deleting a question removes its attempts and its mistake-book row', () => {
  const store = new LearningStore(':memory:');
  const [c] = store.saveQuestions({ questions: [choice] });
  store.answerQuestion({ id: c.id, answer: 'A' });
  store.deleteQuestion({ id: c.id });
  assert.equal(store.db.prepare('SELECT count(*) n FROM quiz_attempts').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM quiz_mistakes').get().n, 0);
  assert.throws(() => store.deleteQuestion({ id: c.id }), { kind: 'not-found' });
  store.close();
});

test('a schema 4 library opens at the latest schema with its data intact', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-quiz-')), 'learning.db');
  const db = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, 4)) step(db, {});
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 4`);
  db.prepare("INSERT INTO kb_documents(title, kind, chars, chunk_count, created_at, updated_at) VALUES ('kept', 'txt', 1, 0, 1, 1)").run();
  db.close();
  const store = new LearningStore(file);
  assert.ok(SCHEMA_VERSION >= 5);
  assert.equal(store.version, SCHEMA_VERSION);
  assert.equal(store.listDocuments()[0].title, 'kept');
  assert.deepEqual(store.listQuestions(), []);
  store.close();
});

test('schema 9: questions already in the mistake book are due at once, and exports carry review dates', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-quiz-')), 'learning.db');
  const db = new DatabaseSync(file);
  for (const step of MIGRATIONS.slice(0, 8)) step(db, {});
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 8`);
  db.prepare("INSERT INTO quiz_questions(id, kind, prompt, answer, created_at) VALUES (1, 'short', 'p', 'a', 5)").run();
  db.prepare('INSERT INTO quiz_mistakes(question_id, streak, added_at, updated_at) VALUES (1, 1, 5, 7)').run();
  db.close();
  const store = new LearningStore(file, { now: () => T0 });
  assert.ok(SCHEMA_VERSION >= 9);
  assert.deepEqual(store.listQuestions({ due: true }).map((q) => [q.id, q.mistakeStreak, q.reviewAt]), [[1, 1, 7]]);
  store.close();
});

// The plugin: routes and the tool

function plugin(storeOptions) {
  const routes = new Map();
  const tools = [];
  const handlers = new Map();
  const disposers = [];
  const ctx = {
    effect: (run) => { const d = run(); if (typeof d === 'function') disposers.push(d); },
    on: (name, handler) => handlers.set(name, handler),
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register: (tool, options) => { const entry = { tool, options }; tools.push(entry); return () => tools.splice(tools.indexOf(entry), 1); } },
  };
  new Learning(ctx, { file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-quiz-plugin-')), 'l.db'), embedder: null, storeOptions });
  const post = async (method, body) => {
    const response = await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body ?? {}) }));
    return { status: response.status, body: await response.json() };
  };
  return { tools, post, dispose: () => disposers.reverse().forEach((d) => d()) };
}

const agent = (id) => ({ session: { id, header: {} } });

test('the learning_quiz tool is offered only in learning sessions, saves and grades', async () => {
  const p = plugin();
  assert.deepEqual(p.tools.map((t) => t.tool.name), [TOOL, 'deep_research']);
  const { tool, options } = p.tools[0];
  assert.equal(tool.name, TOOL);
  assert.equal(options.when({ agent: agent('plain') }), false);
  await p.post('sessions.setMode', { sessionId: 'quiz-1', mode: 'quiz' });
  assert.equal(options.when({ agent: agent('quiz-1') }), true);
  assert.equal(options.when({ agent: { session: { id: 'quiz-1', header: { origin: 'subagent' } } } }), false);

  const saved = await tool.execute({ action: 'save', questions: [choice] }, { agent: agent('quiz-1') });
  const id = saved.saved[0].id;
  assert.match(tool.output.render({ action: 'save' }, saved)[0].text, /do not reveal the answer/);
  const graded = await tool.execute({ action: 'grade', questionId: id, answer: '我选 A' }, { agent: agent('quiz-1') });
  assert.equal(graded.verdict, 'incorrect');
  assert.match(tool.output.render({ action: 'grade' }, graded)[0].text, /mistake book/);
  const listed = await tool.execute({ action: 'list', mistakes: true }, {});
  assert.deepEqual(listed.questions.map((q) => q.id), [id]);
  assert.equal('answer' in listed.questions[0], false, 'listing never shows the answer to the model');
  await assert.rejects(tool.execute({ action: 'grade', answer: 'A' }, {}), /questionId/);

  const book = await p.post('quiz.questions.list', { mistakes: true });
  assert.equal(book.body.result[0].sessionId, 'quiz-1');
  const redo = await p.post('quiz.answer', { id, answer: 'B' });
  assert.equal(redo.body.result.mistakeBook, 'in');
  assert.equal((await p.post('quiz.questions.get', { id })).body.result.answer, 'B');
  assert.equal((await p.post('quiz.answer', { id, answer: 'Z' })).status, 400);
  p.dispose();
  assert.equal(p.tools.length, 0, 'the tool goes away with the plugin');
});

// Every case the tool returns must cross DSH's Remote boundary: one undefined field (a short
// answer's `chosen`, the `streak` of a question not in the book) failed the whole call on
// the phone with "value is not lossless JSON" (only a wrong multiple-choice answer passed).
test('every learning_quiz result is lossless JSON', async () => {
  let clock = T0;
  const p = plugin({ now: () => clock });
  const { tool } = p.tools[0];
  await p.post('sessions.setMode', { sessionId: 'quiz-json', mode: 'quiz' });
  const ctx = { agent: agent('quiz-json') };
  const lossless = (value, what) => assert.ok(isRemoteJsonValue(value), `${what}: ${JSON.stringify(value)}`);
  const saved = await tool.execute({ action: 'save', questions: [choice, short, { kind: 'choice', prompt: '3 + 3 = ?', options: ['6', '7'], answer: 'A' }] }, ctx);
  lossless(saved, 'save');
  const [c, s, c2] = saved.saved.map((q) => q.id);
  lossless(await tool.execute({ action: 'grade', questionId: c2, answer: 'A' }, ctx), 'choice right, never in the book');
  lossless(await tool.execute({ action: 'grade', questionId: c, answer: 'A' }, ctx), 'choice wrong, into the book');
  const early = await tool.execute({ action: 'grade', questionId: c, answer: 'B' }, ctx);
  assert.equal(early.early, true);
  assert.match(tool.output.render({ action: 'grade' }, early)[0].text, /does not count/);
  lossless(early, 'choice right too soon, still in the book');
  lossless(await tool.execute({ action: 'list', due: true }, ctx), 'list what is due (nothing)');
  for (const days of [1, 3]) {
    clock += days * DAY_MS;
    lossless(await tool.execute({ action: 'grade', questionId: c, answer: 'B' }, ctx), 'choice right on its review day, still in the book');
  }
  assert.deepEqual((await tool.execute({ action: 'list', due: true }, ctx)).questions, []);
  clock += 7 * DAY_MS;
  assert.deepEqual((await tool.execute({ action: 'list', due: true }, ctx)).questions.map((q) => q.id), [c]);
  const out = await tool.execute({ action: 'grade', questionId: c, answer: 'B' }, ctx);
  assert.equal(out.mistakeBook, 'removed');
  assert.equal('streak' in out, false);
  lossless(out, 'choice right, out of the book');
  const shortRule = await tool.execute({ action: 'grade', questionId: s, answer: '切线的斜率' }, ctx);
  assert.equal('chosen' in shortRule, false);
  lossless(shortRule, 'short, graded by rule');
  lossless(await tool.execute({ action: 'grade', questionId: s, answer: '斜率', judged: 'correct' }, ctx), 'short, judged by the model');
  lossless(await tool.execute({ action: 'list' }, ctx), 'list');
  lossless(await tool.execute({ action: 'list', mistakes: true }, ctx), 'list the book');
  // The app's routes too: review and stats go to the phone as JSON.
  const review = await p.post('quiz.review', { tzOffset: 480 });
  assert.equal(review.status, 200);
  assert.equal(review.body.result.tzOffset, 480);
  const stats = await p.post('stats.get', { days: 3 });
  assert.equal(stats.body.result.days.length, 3);
  assert.equal((await p.post('stats.get', { tzOffset: 'x' })).status, 400);
  p.dispose();
});

test('the quiz skill tells the model to use the tool', () => {
  const text = fs.readFileSync(new URL('../skills/learning-quiz/SKILL.md', import.meta.url), 'utf8');
  assert.match(text, /learning_quiz/);
  assert.doesNotMatch(text, /not saved to a question bank/);
});
