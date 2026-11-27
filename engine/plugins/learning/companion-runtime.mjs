// Firefly 伙伴 at work (D55, groups D56): what companion.mjs decides, wired to the turns, the
// model and the phone. Who is a companion: the one Bot the user chose, in its own chat and in
// the groups it is in; and, when the user leaves it on, each group's admin in its group. Never
// another member, a subagent or a reminder. Every failure here is logged and swallowed: a turn
// never fails because of the companion.
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  DIGEST_SYSTEM, EPISODE, GAP_MS, IDLE_MS, NOTE_SOURCE, OPENER_SYSTEM, REACH, REACH_SOURCE,
  groupLines, groupSections, groupUserText, openThread, openerPrompt, parseDigest, parseOpener, planReach, reachText,
  recallEpisodes, recentMood, sessionSections, standingTraits, transcript, turnSections, whenSaid,
} from './companion.mjs';
import { callModel as defaultCallModel, sessionTarget } from './research-tool.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Plans are thought about at most this often (each may be a model call). */
const PLAN_EVERY_MS = 6 * HOUR;
/** A group is a place to speak first in only while the user has talked there lately. */
const GROUP_ACTIVE_MS = 14 * DAY;

const textOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();

/** The lines of a Bot's own chat a digest reads: the user's own words and the companion's answers. */
export function conversationLines(messages) {
  const lines = [];
  for (const m of messages ?? []) {
    if (m?.role === 'user' && (m.source?.kind ?? 'user') === 'user') {
      const text = textOf(m);
      if (text) lines.push({ role: 'user', text });
    } else if (m?.role === 'assistant') {
      const text = textOf(m);
      if (text) lines.push({ role: 'assistant', text });
    }
  }
  return lines;
}

const userText = (messages) => messages.filter((m) => m?.role === 'user' && (m.source?.kind ?? 'user') === 'user').map(textOf).join('\n');

export function noteOf(sections) {
  return createUserMessage({ content: [{ type: 'text', text: sections.join('\n\n') }], source: { kind: NOTE_SOURCE } });
}

export class Companion {
  /**
   * @param {{ open: () => import('./store.mjs').LearningStore, team: import('./dsbot.mjs').TeamIndex,
   *   get: (name: string) => any, agents?: any, logger?: any, callModel?: Function, random?: () => number,
   *   timers?: { set: Function, clear: Function } }} deps
   */
  constructor({ open, team, get, agents, logger, callModel = defaultCallModel, random = Math.random, timers }) {
    Object.assign(this, { open, team, get, agents, logger, callModel, random });
    this.timers = timers ?? { set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clear: (t) => clearTimeout(t) };
    /** Idle timers and running digests, by Session. */
    this.idle = new Map();
    this.running = new Map();
    /** Notifications the phone should take back: reaches called off since it last asked. */
    this.calledOff = new Set();
  }

  /**
   * Who a Session is the companion for, or undefined: the chosen Bot's own chat ('dm'), or a
   * group Session of the chosen Bot or of the group's admin ('room:<id>').
   */
  contextOf(sessionId) {
    const owner = this.team.ownerOf(sessionId);
    if (!owner) return undefined;
    const settings = this.open().companionSettings();
    if (owner.kind === 'bot') {
      return settings.botId && owner.botId === settings.botId ? { botId: owner.botId, scope: 'dm', key: owner.botId } : undefined;
    }
    if (owner.kind !== 'member') return undefined;
    const room = this.team.room(owner.roomId);
    if (!room) return undefined;
    const admin = room.admin === owner.botId;
    if (!(admin && settings.groupAdmins) && !(settings.botId && owner.botId === settings.botId)) return undefined;
    let learning = false;
    try { learning = this.open().getOwnerMode({ kind: 'room', id: room.id }) !== null; } catch { /* no learning tables: not learning */ }
    return { botId: owner.botId, roomId: room.id, scope: `room:${room.id}`, key: `room:${room.id}`, admin, learning, room, recallDm: settings.groupRecallDm };
  }

  /** The scopes an episode may come to mind from, in a context. */
  #scopes(context) {
    if (context.scope === 'dm') return undefined; // its own chat: everything it lived through with ta
    return context.recallDm ? [context.scope, 'dm'] : [context.scope];
  }

  #roomNames() { return new Map(this.team.rooms().map((r) => [r.id, r.name])); }

  /** The notes for a turn of a companion (empty for anything else). */
  preStep({ agent, messages }) {
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string' || agent?.session?.header?.origin === 'subagent') return [];
    const context = this.contextOf(sessionId);
    if (!context) return [];
    const store = this.open();
    const now = store.now();
    const zone = store.tzOffset;
    const dm = context.scope === 'dm';
    const said = dm ? userText(messages) : groupUserText(messages);
    const reach = dm && messages.some((m) => m?.source?.kind === REACH_SOURCE);
    if (!said && !reach) return [];
    const target = sessionTarget(agent);
    if (target) store.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(`companion_target:${context.botId}`, JSON.stringify(target));
    const cursor = store.companionCursor(sessionId);
    const sections = [];
    if (!cursor.announced) {
      sections.push(...sessionSections({
        traits: standingTraits(store.companionTraits({ botId: context.botId }), now),
        mood: recentMood(store.companionMoods({ botId: context.botId }), now),
        now,
        tzOffset: zone,
      }));
      if (!dm) sections.push(...groupSections({ roomName: context.room.name, admin: context.admin, learning: context.learning, recallDm: context.recallDm }));
      store.updateCompanionCursor(sessionId, { announced: true });
    }
    if (said) {
      const lastUserAt = store.companionLastUserAt(context.key);
      for (const id of store.companionUserTurn(context.key, REACH.answerHours * HOUR).cancelled) this.calledOff.add(id);
      // A break since the last turn: what came before is one conversation, digested now.
      if (cursor.lastTurnAt && now - cursor.lastTurnAt > GAP_MS) void this.digest(context, agent);
      // In a learning mode the lesson comes first: no old stories, no open threads.
      if (!context.learning) {
        const episodes = store.companionEpisodes({ botId: context.botId, scopes: this.#scopes(context) });
        const recalled = recallEpisodes(episodes, said, { now, shown: new Set(cursor.shown) });
        const thread = !lastUserAt || now - lastUserAt >= 3 * HOUR ? openThread(episodes, { now, tzOffset: zone }) : undefined;
        sections.push(...turnSections({
          episodes: recalled, thread: thread && !recalled.some((e) => e.id === thread.id) ? thread : undefined, now, tzOffset: zone, rooms: this.#roomNames(), inGroup: !dm,
        }));
        if (recalled.length) store.markRecalled(recalled.map((e) => e.id), sessionId);
        if (thread) store.markFollowedUp(thread.id);
      }
      store.updateCompanionCursor(sessionId, { lastTurnAt: now });
      this.#armIdle(context, agent);
    }
    return sections.length ? [noteOf(sections)] : [];
  }

  #armIdle(context, agent) {
    const sessionId = agent.session.id;
    const old = this.idle.get(sessionId);
    if (old) this.timers.clear(old);
    this.idle.set(sessionId, this.timers.set(() => { this.idle.delete(sessionId); void this.digest(context, agent); }, IDLE_MS));
  }

  /** Turn what was said since the last digest into episodes, traits and mood. One per Session at a time. */
  digest(context, agent) {
    const sessionId = agent?.session?.id;
    if (this.running.has(sessionId)) return this.running.get(sessionId);
    const run = this.#digest(context, agent)
      .catch((error) => { this.logger?.warn?.(`companion: digest failed: ${error?.message ?? error}`); return { kept: 0, error: String(error?.message ?? error) }; })
      .finally(() => this.running.delete(sessionId));
    this.running.set(sessionId, run);
    return run;
  }

  async #digest(context, agent) {
    const store = this.open();
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string') return { kept: 0, skipped: 'no-session' };
    let messages = [];
    try { messages = agent.session.deriveMessages?.() ?? []; } catch { return { kept: 0, skipped: 'unreadable' }; }
    const cursor = store.companionCursor(sessionId);
    const start = cursor.digested <= messages.length ? cursor.digested : messages.length;
    const bot = this.team.bot(context.botId);
    const dm = context.scope === 'dm';
    const lines = dm ? conversationLines(messages.slice(start)) : groupLines(messages.slice(start), bot?.name);
    const said = lines.filter((l) => l.role === 'user').map((l) => l.text).join('');
    if ([...said].length < 15) {
      store.updateCompanionCursor(sessionId, { digested: messages.length });
      return { kept: 0, skipped: 'too-little' };
    }
    if (store.companionDigestsToday(context.botId) >= EPISODE.digestsPerDay) return { kept: 0, skipped: 'daily-limit' };
    const llm = this.get('llm');
    const target = sessionTarget(agent) ?? this.#savedTarget(context.botId);
    if (!llm || !target) return { kept: 0, skipped: 'no-model' };
    const now = store.now();
    const at = cursor.lastTurnAt ?? now;
    const where = dm ? '' : `这段是群聊「${context.room.name}」里的对话，在场的有 ta、${context.room.members.filter((id) => id !== context.botId).map((id) => this.team.bot(id)?.name ?? id).join('、') || '别的 Bot'} 和我。`;
    const user = `${where}这段聊天发生在${whenSaid(at, now, store.tzOffset)}。\n\n${transcript(lines, { botName: bot?.name ?? '我' })}`;
    const answer = await this.callModel(llm, target, { system: DIGEST_SYSTEM, user, maxTokens: 1500 });
    store.countDigest(context.botId);
    const result = store.saveDigest({ botId: context.botId, digest: parseDigest(answer), happenedAt: at, scope: context.scope });
    store.updateCompanionCursor(sessionId, { digested: messages.length });
    return { kept: result.episodes.length, hidden: result.hidden };
  }

  #savedTarget(botId) {
    try { return JSON.parse(this.open().db.prepare('SELECT value FROM meta WHERE key = ?').get(`companion_target:${botId}`)?.value ?? 'null') ?? undefined; } catch { return undefined; }
  }

  #agentOf(sessionId) {
    if (!sessionId) return undefined;
    try { return this.agents?.get?.(sessionId) ?? undefined; } catch { return undefined; }
  }

  async #resolve(sessionId) {
    const known = this.#agentOf(sessionId);
    if (known) return known;
    const controller = this.get('sessionController');
    if (!sessionId || typeof controller?.resolveAgent !== 'function') return undefined;
    try { return await controller.resolveAgent(sessionId); } catch { return undefined; }
  }

  /** A reach as the phone shows it: who, where, and the chat a tap opens. */
  #shown(reach) {
    const room = reach.roomId ? this.team.room(reach.roomId) : undefined;
    return {
      ...reach,
      botName: this.team.bot(reach.botId)?.name ?? '',
      roomName: room?.name ?? null,
      sessionId: room ? room.sessionId : this.team.bot(reach.botId)?.sessionId ?? null,
    };
  }

  /** Where the companions may speak first: the chosen Bot's chat, and groups with an admin the user talked in lately. */
  #places(settings, now) {
    const places = [];
    if (settings.botId) places.push({ botId: settings.botId, key: settings.botId });
    if (settings.groupAdmins) {
      for (const room of this.team.rooms()) {
        if (!room.admin) continue;
        const last = this.open().companionLastUserAt(`room:${room.id}`);
        if (last && now - last <= GROUP_ACTIVE_MS) places.push({ botId: room.admin, roomId: room.id, key: `room:${room.id}`, room });
      }
    }
    return places;
  }

  /**
   * The phone is going to the background: whether, when, where and what a companion says first.
   * One at a time and one a day across the chat and the groups (the place the user was in last).
   * A planned one is returned as it is (no new model call); a decision not to is kept for a while.
   * @returns {Promise<{ plan?: object, skip?: string }>}
   */
  async plan({ tzOffset, allowed = true } = {}) {
    const store = this.open();
    if (tzOffset !== undefined) store.useClock(tzOffset);
    const settings = store.companionSettings();
    if (!settings.reach) return { skip: 'off' };
    if (!allowed) return { skip: 'no-notifications' };
    const planned = store.companionReaches({ status: 'planned', limit: 1 })[0];
    if (planned) return { plan: this.#shown(planned) };
    const now = store.now();
    const places = this.#places(settings, now);
    if (!places.length) return { skip: settings.botId ? 'never-talked' : 'no-companion' };
    const checked = Number(store.db.prepare("SELECT value FROM meta WHERE key = 'companion_plan_checked'").get()?.value ?? 0);
    if (now - checked < PLAN_EVERY_MS) return { skip: 'thought-recently' };
    store.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('companion_plan_checked', ?)").run(String(now));
    store.settleIgnoredReaches(REACH.answerHours * HOUR);
    const place = places.map((p) => ({ ...p, lastUserAt: store.companionLastUserAt(p.key) }))
      .sort((a, b) => (b.lastUserAt ?? 0) - (a.lastUserAt ?? 0))[0];
    const last = store.companionReaches({ limit: 5 }).find((r) => r.status !== 'cancelled');
    const decision = planReach({
      now, tzOffset: store.tzOffset, lastUserAt: place.lastUserAt, lastReachAt: last?.fireAt,
      ignored: store.ignoredReaches(), quietStart: settings.quietStart, quietEnd: settings.quietEnd, random: this.random,
    });
    if (decision.skip) return { skip: decision.skip };
    const llm = this.get('llm');
    const target = this.#savedTarget(place.botId);
    if (!llm || !target) return { skip: 'no-model' };
    const bot = this.team.bot(place.botId);
    // In a group, only what happened in that group; in the chat, what they lived through anywhere.
    const recent = store.companionEpisodes({ botId: place.botId, limit: 20, scopes: place.roomId ? [place.key] : undefined })
      .filter((e) => now - e.happenedAt <= 7 * DAY).slice(0, 4);
    let learning = false;
    if (place.roomId) { try { learning = store.getOwnerMode({ kind: 'room', id: place.roomId }) !== null; } catch { /* not learning */ } }
    const user = openerPrompt({
      botName: bot?.name ?? 'Bot', persona: [bot?.role, bot?.instructions].filter(Boolean).join('\n'),
      traits: standingTraits(store.companionTraits({ botId: place.botId }), now), episodes: recent, fireAt: decision.fireAt, tzOffset: store.tzOffset, now,
      room: place.room ? { name: place.room.name, members: place.room.members.filter((id) => id !== place.botId).map((id) => this.team.bot(id)?.name ?? id), learning } : undefined,
    });
    const text = parseOpener(await this.callModel(llm, target, { system: OPENER_SYSTEM, user, maxTokens: 200 }));
    if (!text) return { skip: 'nothing-to-say' };
    return { plan: this.#shown(store.addReach({ botId: place.botId, roomId: place.roomId, fireAt: decision.fireAt, text })) };
  }

  /**
   * The phone is in front again: a reach whose time has come is said (in the companion's chat by
   * the companion, in a group as the admin's post); one too old is dropped; a conversation left
   * idle is digested. Returns what the phone should take off its notifications.
   */
  async wake({ tzOffset } = {}) {
    const store = this.open();
    if (tzOffset !== undefined) store.useClock(tzOffset);
    const out = { delivered: [], expired: [], cancelled: [...this.calledOff] };
    this.calledOff.clear();
    const now = store.now();
    for (const reach of store.companionReaches({ status: 'planned', limit: 5 })) {
      if (reach.fireAt > now) continue;
      if (now - reach.fireAt > REACH.staleHours * HOUR) {
        store.setReachStatus(reach.id, 'expired');
        out.expired.push(reach.id);
        continue;
      }
      const delivered = reach.roomId ? await this.#postInGroup(reach) : await this.#sayInChat(reach, store.tzOffset);
      if (!delivered) continue;
      store.setReachStatus(reach.id, 'delivered');
      out.delivered.push(reach.id);
    }
    const { botId } = store.companionSettings();
    const agent = botId ? this.#agentOf(this.team.bot(botId)?.sessionId) : undefined;
    const sessionId = agent?.session?.id;
    if (sessionId) {
      const cursor = store.companionCursor(sessionId);
      if (cursor.lastTurnAt && now - cursor.lastTurnAt > IDLE_MS) void this.digest({ botId, scope: 'dm', key: botId }, agent);
    }
    return out;
  }

  /** The companion says it in its own chat: a turn of its own, so it can phrase it as it talks now. */
  async #sayInChat(reach, tzOffset) {
    const agent = await this.#resolve(this.team.bot(reach.botId)?.sessionId);
    if (!agent?.followup) return false;
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: reachText({ text: reach.text, fireAt: reach.fireAt, tzOffset }) }],
      source: { kind: REACH_SOURCE, reachId: reach.id },
    }));
    return true;
  }

  /**
   * The admin's post in its group, as ds-bot posts a member's message (groups.js postToRoom):
   * into the group's own Session, `quiet` so that no member is called to answer it.
   */
  async #postInGroup(reach) {
    const room = this.team.room(reach.roomId);
    const bot = this.team.bot(reach.botId);
    if (!room || !bot || room.admin !== reach.botId) return false;
    const agent = await this.#resolve(room.sessionId);
    if (!agent?.followup) return false;
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `[Group post from ${bot.name}]\n${reach.text}` }],
      source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: randomUUID(), senderName: bot.name, senderSessionId: bot.id, roomId: room.id, quiet: true, companionReach: reach.id },
    }));
    return true;
  }

  /** What the companion page shows. */
  status() {
    const store = this.open();
    const settings = store.companionSettings();
    const now = store.now();
    const botId = settings.botId;
    const planned = store.companionReaches({ status: 'planned', limit: 1 })[0];
    return {
      settings,
      botName: botId ? this.team.bot(botId)?.name ?? null : null,
      traits: botId ? standingTraits(store.companionTraits({ botId }), now) : [],
      mood: botId ? recentMood(store.companionMoods({ botId }), now) ?? null : null,
      episodes: store.companionEpisodes({ limit: 2000 }).length,
      planned: planned ? this.#shown(planned) : null,
    };
  }

  /** Digest the companion's own chat now (the page's 「现在整理」). */
  digestNow() {
    const { botId } = this.open().companionSettings();
    const agent = botId ? this.#agentOf(this.team.bot(botId)?.sessionId) : undefined;
    if (!agent) return Promise.resolve({ kept: 0, skipped: 'not-open' });
    return this.digest({ botId, scope: 'dm', key: botId }, agent);
  }

  dispose() {
    for (const t of this.idle.values()) this.timers.clear(t);
    this.idle.clear();
  }
}
