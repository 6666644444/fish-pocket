// Learning modes of Bots and group chats (batch 2): dsbot.mjs reads ds-bot's saved team, the
// turn note follows the Bot or the group, the group's admin teaches. The team file is built
// in ds-bot 0.3.8's own shape (src/host/store.js, index.js), and the messages carry the
// sources ds-bot 0.3.8 and DSH give them (delivery.js relays, dsh-schedule 'schedule').
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import Learning, { ROUTE, pausedResearchNote, quizAllowed, turnNote } from '../plugins/learning/index.mjs';
import { TeamIndex, indexTeam, learningOwner, learningTurn, ownerKey, teamFile } from '../plugins/learning/dsbot.mjs';
import { TOOL as QUIZ } from '../plugins/learning/quiz-tool.mjs';
import { LearningStore, SCHEMA_VERSION } from '../plugins/learning/store.mjs';
import { dumpLibrary, importLibrary } from '../plugins/learning/portable.mjs';

const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A team as ds-bot 0.3.8 saves it: two Bots, one of them with an earlier part, and a group. */
function team({ admin = 'bot-hei', mode = 'admin', members = ['bot-hei', 'bot-test'] } = {}) {
  return {
    version: 9,
    bots: {
      'bot-hei': { id: 'bot-hei', name: '嘿', sessionId: 's-hei-2', segments: [{ sessionId: 's-hei-1', at: 1 }] },
      'bot-test': { id: 'bot-test', name: '测试', sessionId: 's-test', openParts: [{ sessionId: 's-test-open', segments: [] }] },
    },
    rooms: {
      'room-g3': {
        id: 'room-g3', name: '高三', members, ...(admin ? { admin } : {}), mode,
        sessionId: 's-room', parts: [{ sessionId: 's-room-old' }],
        sessions: { 'bot-hei': 's-g3-hei', 'bot-test': 's-g3-test' },
        segments: { 'bot-test': [{ sessionId: 's-g3-test-old' }] },
        log: [], seen: {},
      },
    },
  };
}

function home(state = team()) {
  const dir = temp('dsh-learning-team-');
  fs.mkdirSync(path.join(dir, 'bot'), { recursive: true });
  fs.writeFileSync(teamFile(dir), JSON.stringify(state));
  return dir;
}

const writeTeam = (dir, state) => {
  fs.writeFileSync(teamFile(dir), JSON.stringify(state));
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(teamFile(dir), later, later);
};

function plugin(dir) {
  const routes = new Map();
  const handlers = new Map();
  const tools = [];
  const ctx = {
    effect: (run) => run(),
    on: (name, handler) => { handlers.set(name, handler); },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } },
    tools: { register: (tool, options) => { tools.push({ tool, options }); return () => {}; } },
  };
  const instance = new Learning(ctx, { file: path.join(dir, 'learning', 'learning.db'), embedder: null, services: {} });
  const post = async (method, body) => {
    const response = await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body ?? {}) }));
    return { status: response.status, body: await response.json() };
  };
  const preStep = handlers.get('agent/pre-step');
  const step = (sessionId, messages) => preStep({ agent: { session: { id: sessionId, header: {} } }, step: 1, signal: { aborted: false } }, async () => ({ kind: 'proceed', messages }));
  const notes = async (sessionId, messages) => (await step(sessionId, messages)).messages.slice(messages.length);
  const quizWhen = tools.find((t) => t.tool.name === QUIZ).options.when;
  return { instance, post, notes, quizWhen };
}

const user = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
const relay = (role, text, extra = {}) => ({ role: 'user', source: { kind: 'bot', form: 'relay', role, exchangeId: 'x', senderName: 'You', ...extra }, content: [{ type: 'text', text }] });
const reminder = () => ({ role: 'user', source: { kind: 'schedule' }, content: [{ type: 'text', text: '[SCHEDULE REMINDER]\nThis is a scheduled message from the user' }] });
const names = (list) => list.flatMap((m) => m.source.sections.map((s) => s.name));
const text = (list) => list.map((m) => m.content[0].text).join('\n');

// Reading the team

test('the team index: Bot chats with every part, member Sessions, the group\'s own Session', () => {
  const index = indexTeam(team());
  assert.deepEqual(index.sessions.get('s-hei-2'), { kind: 'bot', botId: 'bot-hei' });
  assert.deepEqual(index.sessions.get('s-hei-1'), { kind: 'bot', botId: 'bot-hei' }, 'an earlier part');
  assert.deepEqual(index.sessions.get('s-test-open'), { kind: 'bot', botId: 'bot-test' }, 'a part opened while busy');
  assert.deepEqual(index.sessions.get('s-g3-hei'), { kind: 'member', botId: 'bot-hei', roomId: 'room-g3' });
  assert.deepEqual(index.sessions.get('s-g3-test-old'), { kind: 'member', botId: 'bot-test', roomId: 'room-g3' });
  assert.deepEqual(index.sessions.get('s-room'), { kind: 'room', roomId: 'room-g3' });
  assert.deepEqual(index.sessions.get('s-room-old'), { kind: 'room', roomId: 'room-g3' });
  assert.deepEqual(index.rooms.get('room-g3'), { id: 'room-g3', name: '高三', members: ['bot-hei', 'bot-test'], admin: 'bot-hei', mode: 'admin', sessionId: 's-room' });
  assert.equal(indexTeam(team({ admin: 'gone-bot' })).rooms.get('room-g3').admin, undefined, 'an admin who is not a member is none');
});

test('a missing, broken or odd team file is no team: plain conversations stay as they are', () => {
  const dir = temp('dsh-learning-noteam-');
  const index = new TeamIndex(() => teamFile(dir));
  assert.equal(index.ownerOf('s-hei-2'), undefined);
  fs.mkdirSync(path.join(dir, 'bot'));
  fs.writeFileSync(teamFile(dir), '{ not json');
  assert.equal(index.ownerOf('s-hei-2'), undefined);
  writeTeam(dir, { bots: 'x', rooms: [1, null] });
  assert.equal(index.ownerOf('s-hei-2'), undefined);
  assert.deepEqual(learningOwner(index, 'plain'), { kind: 'session', id: 'plain' });
});

test('owners: a Bot\'s chat follows the Bot, a member\'s group Session the group, the group\'s own Session is a relay', () => {
  const index = new TeamIndex(() => teamFile(home()));
  assert.deepEqual(learningOwner(index, 's-hei-1'), { kind: 'bot', id: 'bot-hei' });
  assert.deepEqual(learningOwner(index, 's-g3-test'), { kind: 'room', id: 'room-g3', botId: 'bot-test' });
  assert.deepEqual(learningOwner(index, 's-room'), { kind: 'relay', id: 'room-g3' });
  assert.equal(ownerKey(index, 's-hei-1'), ownerKey(index, 's-hei-2'), 'one key for all of a Bot\'s parts');
  assert.equal(ownerKey(index, 's-g3-hei'), ownerKey(index, 's-g3-test'), 'one key for all of a group\'s members');
  assert.equal(ownerKey(index, 's-room'), 'room:room-g3');
});

test('which turns are the learner\'s: by ds-bot\'s relay roles, never a reminder', () => {
  assert.equal(learningTurn('session', [user('hi')]), true);
  assert.equal(learningTurn('session', [reminder()]), false);
  assert.equal(learningTurn('bot', [user('教我导数')]), true, 'the user in the Bot\'s chat (the app, an IM chat)');
  assert.equal(learningTurn('bot', [relay('continue', '[Retry after a failed turn]')]), true);
  assert.equal(learningTurn('bot', [relay('resume', '[DeepSeek Harness restarted while you were working]')]), true);
  for (const errand of ['request', 'reply', 'report', 'stopped', 'kickoff', 'update', 'secret', 'goal']) {
    assert.equal(learningTurn('bot', [relay(errand, 'x')]), false, errand);
  }
  assert.equal(learningTurn('bot', [reminder()]), false);
  assert.equal(learningTurn('room', [relay('room', '[Group chat "高三" · your turn]\nUser: 什么是导数')]), true);
  assert.equal(learningTurn('room', [relay('report', 'x')]), true);
  for (const other of ['kickoff', 'update', 'secret', 'goal', 'request']) assert.equal(learningTurn('room', [relay(other, 'x')]), false, other);
  assert.equal(learningTurn('room', [reminder()]), false);
});

// Turns

test('a Bot in learning mode: full note once per part, the Bot stays itself, memories, then reminders', async () => {
  const p = plugin(home());
  await p.post('memories.create', { content: '导数的几何意义掌握得不好' });
  assert.equal((await p.post('owners.set', { kind: 'bot', id: 'bot-hei', mode: 'socratic' })).body.result.name, '嘿');
  const first = await p.notes('s-hei-2', [user('导数的几何意义是什么')]);
  assert.deepEqual(names(first), ['learning-mode', 'learning-memory', 'learning-bot']);
  assert.match(text(first), /own character/);
  const again = await p.notes('s-hei-2', [user('再讲一遍')]);
  assert.equal(names(again)[0], 'learning-mode');
  assert.doesNotMatch(text(again), /own character/, 'a reminder the second time');
  const fresh = await p.notes('s-hei-1', [user('新的一段')]);
  assert.ok(names(fresh).includes('learning-bot'), 'another part of the chat gets the full note again');
  assert.deepEqual(await p.notes('s-test', [user('hi')]), [], 'another Bot is not in learning mode');
});

test('a Bot\'s errands, reminders and kickoffs get no learning note', async () => {
  const p = plugin(home());
  await p.post('owners.set', { kind: 'bot', id: 'bot-hei', mode: 'quiz' });
  assert.deepEqual(await p.notes('s-hei-2', [relay('request', '[Message from 测试]\n帮我查一下')]), []);
  assert.deepEqual(await p.notes('s-hei-2', [reminder()]), []);
  assert.deepEqual(await p.notes('s-hei-2', [relay('kickoff', '[Bot team setup]')]), []);
  assert.equal((await p.notes('s-hei-2', [relay('continue', '[Retry after a failed turn]')])).length, 1);
});

test('a group in learning mode: the admin teaches, the others assist, the group\'s own Session gets nothing', async () => {
  const p = plugin(home());
  await p.post('memories.create', { content: '函数单调性总出错' });
  const set = (await p.post('owners.set', { kind: 'room', id: 'room-g3', mode: 'socratic' })).body.result;
  assert.deepEqual([set.name, set.teacher, set.paused], ['高三', { id: 'bot-hei', name: '嘿' }, false]);
  const round = [relay('room', '[Group chat "高三" · your turn]\nUser: 函数单调性怎么判断')];
  const teacher = await p.notes('s-g3-hei', round);
  assert.deepEqual(names(teacher), ['learning-mode', 'learning-memory', 'learning-teacher']);
  assert.match(text(teacher), /测试/, 'the teacher is told who the other members are');
  assert.match(text(teacher), /函数单调性总出错/, 'memories come from the user\'s line inside the relay');
  const member = await p.notes('s-g3-test', round);
  assert.deepEqual(names(member), ['learning-member']);
  assert.match(text(member), /嘿/);
  assert.match(text(member), /pass/);
  assert.doesNotMatch(text(member), /函数单调性总出错/, 'learning memories go to the teacher only');
  assert.equal(text(await p.notes('s-g3-test', round)).split('\n').length, 1, 'then a one-line reminder');
  assert.deepEqual(await p.notes('s-room', [relay('post', '[Group post from 嘿]\n…')]), []);
  assert.deepEqual(await p.notes('s-g3-hei', [relay('goal', 'x')]), [], 'goal work is not a lesson');
});

test('only the teacher has the quiz tool; a member, the relay Session and an idle Bot do not', async () => {
  const dir = home();
  const p = plugin(dir);
  const when = (id) => p.quizWhen({ agent: { session: { id, header: {} } } });
  await p.post('owners.set', { kind: 'room', id: 'room-g3', mode: 'quiz' });
  assert.equal(when('s-g3-hei'), true);
  assert.equal(when('s-g3-test'), false);
  assert.equal(when('s-room'), false);
  assert.equal(when('s-hei-2'), false, 'the Bot\'s own chat is not in a mode');
  await p.post('owners.set', { kind: 'bot', id: 'bot-test', mode: 'quiz' });
  assert.equal(when('s-test'), true);
  assert.equal(when('s-test-open'), true);
  writeTeam(dir, team({ admin: 'bot-test' }));
  assert.equal(when('s-g3-test'), true, 'a new admin is the new teacher');
  assert.equal(when('s-g3-hei'), false);
  assert.equal(quizAllowed(new LearningStore(':memory:'), p.instance.team, 'plain'), false);
});

test('changing the admin changes the teacher; no admin pauses the group; an admin back resumes it', async () => {
  const dir = home();
  const p = plugin(dir);
  const round = [relay('room', '[Group chat "高三" · your turn]\nUser: 继续')];
  await p.post('owners.set', { kind: 'room', id: 'room-g3', mode: 'qa' });
  assert.ok(names(await p.notes('s-g3-hei', round)).includes('learning-teacher'));
  writeTeam(dir, team({ admin: 'bot-test' }));
  assert.ok(names(await p.notes('s-g3-test', round)).includes('learning-teacher'), 'the new admin gets the teacher\'s note');
  assert.deepEqual(names(await p.notes('s-g3-hei', round)), ['learning-member'], 'the old one becomes a member');
  writeTeam(dir, team({ admin: null, mode: 'everyone' }));
  assert.deepEqual(await p.notes('s-g3-test', round), [], 'paused without an admin');
  const status = (await p.post('owners.get', { kind: 'room', id: 'room-g3' })).body.result;
  assert.deepEqual([status.mode, status.paused, 'teacher' in status], ['qa', true, false]);
  writeTeam(dir, team());
  assert.equal((await p.notes('s-g3-hei', round)).length, 1, 'back with an admin');
});

test('a group without an admin cannot start learning mode', async () => {
  const p = plugin(home(team({ admin: null, mode: 'everyone' })));
  const refused = await p.post('owners.set', { kind: 'room', id: 'room-g3', mode: 'qa' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /admin/);
  assert.equal((await p.post('owners.set', { kind: 'room', id: 'room-g3', mode: null })).status, 200, 'ending is always allowed');
});

test('ending a Bot\'s or a group\'s mode: each Session that had it is told once; the record lists it', async () => {
  const p = plugin(home());
  const round = [relay('room', '[Group chat "高三" · your turn]\nUser: hi')];
  await p.post('owners.set', { kind: 'room', id: 'room-g3', mode: 'quiz' });
  await p.notes('s-g3-hei', round);
  await p.notes('s-g3-test', round);
  await p.post('owners.set', { kind: 'room', id: 'room-g3', mode: null });
  for (const id of ['s-g3-hei', 's-g3-test']) {
    const told = await p.notes(id, round);
    assert.match(text(told), /ended learning mode/, id);
    assert.deepEqual(await p.notes(id, round), [], `${id}: only once`);
  }
  const history = (await p.post('owners.history')).body.result;
  assert.deepEqual(history.map((o) => [o.kind, o.id, o.mode, o.name]), [['room', 'room-g3', 'quiz', '高三']]);
  assert.deepEqual((await p.post('owners.list')).body.result, []);
  assert.equal((await p.post('owners.hide', { kind: 'room', id: 'room-g3' })).status, 200);
  assert.deepEqual((await p.post('owners.history')).body.result, []);
  await p.post('owners.set', { kind: 'room', id: 'room-g3', mode: 'qa' });
  assert.ok(names(await p.notes('s-g3-hei', round)).includes('learning-teacher'), 'started again: the full note again');
  assert.equal((await p.post('owners.list')).body.result.length, 1);
});

test('a group member\'s note follows the mode: add to answers, hint only, or leave the quiz to the teacher', async () => {
  const p = plugin(home());
  const round = [relay('room', '[Group chat "高三" · your turn]\nUser: 求导')];
  const member = async (mode) => {
    await p.post('owners.set', { kind: 'room', id: 'room-g3', mode });
    return text(await p.notes('s-g3-test', round));
  };
  const qa = await member('qa');
  assert.match(qa, /add to the answer/);
  assert.doesNotMatch(qa, /do not give the answer/, 'a plain Q&A does not hold the answer back');
  const socratic = await member('socratic');
  assert.match(socratic, /small hint/);
  assert.match(socratic, /do not give the answer or the next step outright/);
  assert.match(socratic, /do not ask the learner questions of your own/);
  const quiz = await member('quiz');
  assert.match(quiz, /Do not set questions/);
  assert.match(quiz, /never reveal an answer before the learner has answered/);
  for (const note of [qa, socratic, quiz]) assert.match(note, /pass/);
  assert.match(text(await p.notes('s-g3-test', round)), /no questions, no answers before grading/, 'the one-line reminder follows the mode too');
});

test('owner routes refuse bad input; every result is lossless JSON', async () => {
  const p = plugin(home());
  assert.equal((await p.post('owners.set', { kind: 'session', id: 'x', mode: 'qa' })).status, 400);
  assert.equal((await p.post('owners.set', { kind: 'bot', id: 'bot-hei', mode: 'lecture' })).status, 400);
  assert.equal((await p.post('owners.hide', { kind: 'bot', id: 'never' })).status, 404);
  const got = (await p.post('owners.get', { kind: 'bot', id: 'bot-hei' })).body.result;
  assert.deepEqual([got.mode, got.name], [null, '嘿']);
  for (const method of ['owners.get', 'owners.list', 'owners.history']) {
    assert.ok(isRemoteJsonValue((await p.post(method, { kind: 'bot', id: 'bot-hei' })).body), method);
  }
});

test('a plain conversation is unaffected by the team', async () => {
  const p = plugin(home());
  await p.post('sessions.setMode', { sessionId: 'plain-1', mode: 'qa' });
  assert.deepEqual(names(await p.notes('plain-1', [user('hi')])), ['learning-mode']);
  assert.deepEqual(await p.notes('plain-1', [reminder()]), [], 'a reminder in a plain learning session gets no note either');
});

// Research per owner

test('research runs one at a time per Bot and per group, and a paused one is found from any part', () => {
  const index = new TeamIndex(() => teamFile(home()));
  const store = new LearningStore(':memory:');
  const job = store.createResearchJob({ topic: '导数', depth: 'quick', sessionId: 's-hei-1' });
  store.setResearchStatus({ id: job.id, status: 'paused' });
  const keyOf = (id) => ownerKey(index, id);
  const note = pausedResearchNote(store, 's-hei-2', { running: new Map(), told: new Set(), keyOf });
  assert.match(note.content[0].text, new RegExp(`research #${job.id}`), 'found from the Bot\'s current part');
  assert.equal(pausedResearchNote(store, 's-test', { running: new Map(), told: new Set(), keyOf }), undefined, 'not another Bot\'s');
  const groupJob = store.createResearchJob({ topic: '单调性', depth: 'quick', sessionId: 's-g3-test' });
  store.setResearchStatus({ id: groupJob.id, status: 'paused' });
  assert.match(pausedResearchNote(store, 's-g3-hei', { running: new Map(), told: new Set(), keyOf }).content[0].text, new RegExp(`#${groupJob.id}`), 'any member of the group');
  store.close();
});

test('the research runner refuses a second run in the same group', async () => {
  const dir = home();
  const p = plugin(dir);
  const runner = p.instance.research;
  runner.running.set(99, { controller: new AbortController(), settled: Promise.resolve(), sessionId: 's-g3-hei' });
  assert.equal(runner.runningIn('s-g3-test'), 99);
  assert.equal(runner.runningIn('s-hei-2'), undefined, 'the Bot\'s own chat is another owner');
  runner.running.clear();
});

// The library

test('schema 8: owners survive export and import', () => {
  const store = new LearningStore(':memory:');
  assert.ok(SCHEMA_VERSION >= 8);
  store.setOwnerMode({ kind: 'bot', id: 'bot-hei', mode: 'qa' });
  store.setOwnerMode({ kind: 'room', id: 'room-g3', mode: 'quiz' });
  store.setOwnerMode({ kind: 'room', id: 'room-g3', mode: null });
  const data = dumpLibrary(store);
  assert.deepEqual(data.learningOwners.map((o) => [o.kind, o.id, o.mode, o.endedAt !== null]), [['bot', 'bot-hei', 'qa', false], ['room', 'room-g3', 'quiz', true]]);
  const back = new LearningStore(':memory:');
  importLibrary(back, data);
  assert.equal(back.getOwnerMode({ kind: 'bot', id: 'bot-hei' }).mode, 'qa');
  assert.equal(back.listOwnerHistory()[0].id, 'room-g3');
  store.close();
  back.close();
});

test('turnNote without a team (older callers) behaves as before', () => {
  const store = new LearningStore(':memory:');
  store.setSessionMode({ sessionId: 's1', mode: 'qa' });
  assert.ok(turnNote(store, 's1', []));
  store.close();
});
