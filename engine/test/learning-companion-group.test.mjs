import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Learning, { ROUTE } from '../plugins/learning/index.mjs';
import { NOTE_SOURCE, groupLines, groupUserText, relayEntries } from '../plugins/learning/companion.mjs';
import { DAY_MS } from '../plugins/learning/quiz.mjs';

// Firefly 伙伴 in group chats (D56), against ds-bot 0.3.8's relay text (groups.js roomPrompt).

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 27, 12); // 20:00 China time
const CN = 480;

/** A round as a member's Session gets it. */
const relay = (lines, { earlier = [] } = {}) => ({
  role: 'user',
  source: { kind: 'bot', form: 'relay', role: 'room', roomId: 'room-g3' },
  content: [{
    type: 'text',
    text: [
      '[Group chat "高三" · new message]',
      'Members: the user, 测试 and you (admin). Writing "@Name" calls that member at once.',
      '',
      ...(earlier.length ? ['Earlier in the group, before this round (context only):', ...earlier, ''] : []),
      'This round so far, starting with the new message (oldest first):',
      ...lines,
      '',
      'Reply with your message for the group, no name prefix.',
    ].join('\n'),
  }],
});

test('the round text: who said what, the user\'s words of this round, each line once', () => {
  const m = relay(['User: 周五数学月考', '紧张死了', '测试: 我也是'], { earlier: ['User: 昨天的事', '[The user stopped 测试\'s work here]'] });
  assert.deepEqual(relayEntries(m.content[0].text), [
    { who: 'User', text: '昨天的事' },
    { who: 'User', text: '周五数学月考\n紧张死了' },
    { who: '测试', text: '我也是' },
  ]);
  assert.equal(groupUserText([m]), '周五数学月考\n紧张死了');
  const lines = groupLines([m, { role: 'assistant', content: [{ type: 'text', text: '别慌' }] }, relay(['测试: 我也是', 'User: 好'])], '嘿');
  assert.deepEqual(lines.map((l) => `${l.role}:${l.who ?? ''}:${l.text}`), [
    'user::昨天的事', 'user::周五数学月考\n紧张死了', 'other:测试:我也是', 'assistant::别慌', 'user::好',
  ]);
  assert.equal(groupUserText([{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'User: x' }] }]), '', 'only relays');
});

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-companion-group-'));
  const teamPath = path.join(dir, 'state.json');
  fs.writeFileSync(teamPath, JSON.stringify({
    bots: {
      'bot-hei': { id: 'bot-hei', name: '嘿', sessionId: 's-hei', role: '老师', instructions: '温和，偶尔开玩笑' },
      'bot-test': { id: 'bot-test', name: '测试', sessionId: 's-test' },
      'bot-xy': { id: 'bot-xy', name: '小萤', sessionId: 's-xy' },
    },
    rooms: {
      'room-g3': {
        id: 'room-g3', name: '高三', members: ['bot-hei', 'bot-test', 'bot-xy'], admin: 'bot-hei', mode: 'admin', sessionId: 's-room',
        sessions: { 'bot-hei': 's-g3-hei', 'bot-test': 's-g3-test', 'bot-xy': 's-g3-xy' },
      },
    },
  }));
  const clock = { now: T0 };
  const routes = new Map();
  const handlers = new Map();
  const disposers = [];
  const timers = [];
  const calls = [];
  const answers = [];
  const history = new Map(['s-hei', 's-test', 's-xy', 's-room', 's-g3-hei', 's-g3-test', 's-g3-xy'].map((id) => [id, []]));
  const followups = [];
  const agent = (id) => ({
    id,
    session: { id, header: {}, deriveMessages: () => history.get(id), requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) },
    followup: (message) => followups.push({ id, message }),
  });
  const ctx = {
    effect: (run) => { const d = run(); if (typeof d === 'function') disposers.push(d); },
    on: (name, handler) => handlers.set(name, handler),
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register: () => () => {} },
  };
  new Learning(ctx, {
    file: path.join(dir, 'learning', 'l.db'), teamFile: teamPath, embedder: null, agents: { get: (id) => (history.has(id) ? agent(id) : undefined) },
    storeOptions: { now: () => clock.now }, services: { llm: {} }, random: () => 0,
    timers: { set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => {} },
    callModel: async (_llm, _target, request) => { calls.push(request); return answers.shift() ?? '{}'; },
  });
  const post = async (method, body) => {
    const response = await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body ?? {}) }));
    return (await response.json()).result;
  };
  /** A message into Session `id` (a relay for a group Session): the companion notes it gets. */
  const send = async (id, message) => {
    const decision = await handlers.get('agent/pre-step')({ agent: agent(id), step: 1, signal: new AbortController().signal }, async () => ({ kind: 'continue', messages: [message] }));
    history.get(id).push(message);
    return decision.messages.filter((m) => m.source?.kind === NOTE_SOURCE).map((m) => m.content[0].text).join('\n');
  };
  const dm = (id, text) => send(id, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const group = (id, ...lines) => send(id, relay(lines));
  const reply = (id, text) => history.get(id).push({ role: 'assistant', content: [{ type: 'text', text }] });
  return { clock, post, dm, group, reply, answers, calls, timers, followups, history, dispose: () => disposers.reverse().forEach((d) => d()) };
}

const episodeAnswer = (text, cues, over = {}) => JSON.stringify({ episodes: [{ text, cues, importance: 0.7, emotion: 0.6, ...over }], traits: [], mood: null, retract: [] });

test('in a group the admin is a friend, the chosen Bot is still itself, the other members are untouched', async () => {
  const h = harness();
  await h.post('companion.wake', { tzOffset: CN });
  const admin = await h.group('s-g3-hei', 'User: 大家晚上好');
  assert.match(admin, /【Firefly 伙伴】/);
  assert.match(admin, /【在群里】这是群聊「高三」/);
  assert.match(admin, /你是群主/);
  assert.match(admin, /私下跟你说的事不要在群里提/);
  assert.equal(await h.group('s-g3-test', 'User: 大家晚上好'), '', 'a member that is neither');
  assert.equal(await h.group('s-g3-xy', 'User: 大家晚上好'), '', 'no companion chosen yet');
  await h.post('companion.settings.set', { botId: 'bot-xy' });
  const xy = await h.group('s-g3-xy', 'User: 还有人吗');
  assert.match(xy, /【在群里】/);
  assert.doesNotMatch(xy, /你是群主/);
  assert.equal(await h.group('s-g3-hei', '测试: 我在'), '', 'a round with no word from the user: nothing');
  await h.post('companion.settings.set', { groupAdmins: false });
  h.history.set('s-g3-hei', []);
  const fresh = harness();
  await fresh.post('companion.settings.set', { groupAdmins: false });
  assert.equal(await fresh.group('s-g3-hei', 'User: 在吗'), '', 'switched off: the admin is as before');
  h.dispose();
  fresh.dispose();
});

test('what ta said in private stays out of the group unless allowed; what happened in the group comes up in private', async () => {
  const h = harness();
  await h.post('companion.settings.set', { botId: 'bot-xy' });
  // In private: a secret.
  await h.dm('s-xy', '跟你说个秘密，我其实很怕这次月考，怕爸妈失望');
  h.reply('s-xy', '嗯，我在');
  h.answers.push(episodeAnswer('ta 私下跟我说很怕这次月考，怕爸妈失望，我陪 ta 说了一会儿', ['月考', '爸妈']));
  await h.post('companion.digest', {});
  h.clock.now += DAY_MS;
  const inGroup = await h.group('s-g3-xy', 'User: 月考成绩今天出来');
  assert.doesNotMatch(inGroup, /【脑子里浮现的往事】/, 'not in the group');
  await h.post('companion.settings.set', { groupRecallDm: true });
  h.history.set('s-g3-xy', []);
  h.clock.now += 3 * DAY_MS;
  // A new group part (cursor starts over) with the switch on.
  const allowed = await h.group('s-g3-xy', 'User: 月考成绩今天出来了');
  assert.match(allowed, /【脑子里浮现的往事】/);
  assert.match(allowed, /ta 私下跟你聊的，在群里提之前先想想/, 'marked private, whatever the note said before the switch');
  h.dispose();
});

test('a group conversation becomes an episode of the group, with who was there, and is recalled with its place', async () => {
  const h = harness();
  await h.post('companion.settings.set', { botId: 'bot-hei' });
  await h.group('s-g3-hei', 'User: 我们周末一起去爬山吧，测试你去不去');
  h.reply('s-g3-hei', '好呀，我带零食');
  await h.group('s-g3-hei', '测试: 去！', 'User: 那就说定了，周六早上八点');
  h.answers.push(episodeAnswer('在群里 ta 约我和测试周六早上八点去爬山，我说带零食，测试也答应了', ['爬山', '周六'], { followUp: '周六爬山' }));
  h.timers.at(-1).fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.match(h.calls[0].user, /这段是群聊「高三」里的对话，在场的有 ta、测试、小萤 和我/);
  assert.match(h.calls[0].user, /测试：去！/);
  assert.match(h.calls[0].user, /我（嘿）：好呀，我带零食/);
  const [episode] = await h.post('companion.episodes', {});
  assert.equal(episode.scope, 'room:room-g3');
  // In its own chat a day later, the same subject: recalled, and said where it happened.
  h.clock.now += DAY_MS;
  const later = await h.dm('s-hei', '周六爬山要带什么');
  assert.match(later, /在群「高三」里/);
  h.dispose();
});

test('in a learning mode the admin keeps the friendly tone but brings up no old stories', async () => {
  const h = harness();
  await h.group('s-g3-hei', 'User: 我们来聊聊函数吧，导数那里我一直不懂');
  h.answers.push(episodeAnswer('在群里 ta 说导数一直没搞懂，有点沮丧，我们一起从切线讲起', ['导数', '函数']));
  h.timers.at(-1).fn();
  await new Promise((r) => setTimeout(r, 20));
  await h.post('owners.set', { kind: 'room', id: 'room-g3', mode: 'quiz' });
  h.clock.now += 2 * DAY_MS;
  assert.doesNotMatch(await h.group('s-g3-hei', 'User: 出几道导数题考考我'), /【脑子里浮现的往事】/, 'learning: none');
  await h.post('owners.set', { kind: 'room', id: 'room-g3', mode: null });
  h.clock.now += 60_000;
  assert.match(await h.group('s-g3-hei', 'User: 导数还是好难'), /【脑子里浮现的往事】/, 'out of the mode: it comes to mind again');
  h.dispose();
  // A group in a mode from the first turn: the note says the mode comes first.
  const fresh = harness();
  await fresh.post('owners.set', { kind: 'room', id: 'room-g3', mode: 'quiz' });
  assert.match(await fresh.group('s-g3-hei', 'User: 开始吧'), /学习模式的要求优先/);
  fresh.dispose();
});

test('the admin speaks first in the group the user was in last, as a quiet post nobody is called to answer', async () => {
  const h = harness();
  await h.group('s-g3-hei', 'User: 晚安各位');
  h.reply('s-g3-hei', '晚安');
  h.clock.now += 7 * HOUR;
  h.answers.push('早，昨晚谁最后睡的？');
  const { plan } = await h.post('companion.plan', { tzOffset: CN, allowed: true });
  assert.equal(plan.roomId, 'room-g3');
  assert.equal(plan.botId, 'bot-hei');
  assert.equal(plan.roomName, '高三');
  assert.equal(plan.sessionId, 's-room', 'the notification opens the group');
  assert.match(h.calls.at(-1).user, /发在群聊「高三」里（你是群主，群里还有 测试、小萤 和 ta）/);
  assert.match(h.calls.at(-1).user, /温和，偶尔开玩笑/);
  h.clock.now = plan.fireAt + 60_000;
  const woke = await h.post('companion.wake', { tzOffset: CN });
  assert.deepEqual(woke.delivered, [plan.id]);
  const [sent] = h.followups;
  assert.equal(sent.id, 's-room', "into the group's own Session");
  assert.deepEqual({ kind: sent.message.source.kind, role: sent.message.source.role, quiet: sent.message.source.quiet, from: sent.message.source.senderSessionId, name: sent.message.source.senderName },
    { kind: 'bot', role: 'post', quiet: true, from: 'bot-hei', name: '嘿' });
  assert.equal(sent.message.content[0].text, '[Group post from 嘿]\n早，昨晚谁最后睡的？');
  h.dispose();
});

test('one reach a day across the chat and the groups: the place the user was in last', async () => {
  const h = harness();
  await h.post('companion.settings.set', { botId: 'bot-xy' });
  await h.group('s-g3-hei', 'User: 群里好安静');
  h.clock.now += HOUR;
  await h.dm('s-xy', '还是跟你聊舒服');
  h.clock.now += 7 * HOUR;
  h.answers.push('今天过得怎么样？');
  const { plan } = await h.post('companion.plan', { tzOffset: CN });
  assert.equal(plan.roomId, null, 'the chat was the last place');
  assert.equal(plan.sessionId, 's-xy');
  assert.equal((await h.post('companion.plan', { tzOffset: CN })).plan.id, plan.id, 'still the one planned');
  // The user talks in the group first: the planned one is called off, wherever it was going.
  await h.group('s-g3-hei', 'User: 我回来了');
  assert.deepEqual((await h.post('companion.wake', { tzOffset: CN })).cancelled, [plan.id]);
  h.dispose();
});
