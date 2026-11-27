// Firefly 伙伴 at work (D55): what companion.mjs decides, wired to the turns, the model and
// the phone. Only the one Bot the user chose, in its own chat (never a group, another Bot, a
// subagent or a reminder). Every failure here is logged and swallowed: a turn never fails
// because of the companion.
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  DIGEST_SYSTEM, EPISODE, GAP_MS, IDLE_MS, NOTE_SOURCE, OPENER_SYSTEM, REACH, REACH_SOURCE,
  openThread, openerPrompt, parseDigest, parseOpener, planReach, reachText, recallEpisodes, recentMood,
  sessionSections, standingTraits, transcript, turnSections, whenSaid,
} from './companion.mjs';
import { callModel as defaultCallModel, sessionTarget } from './research-tool.mjs';

const HOUR = 3_600_000;
/** Plans are thought about at most this often (each may be a model call). */
const PLAN_EVERY_MS = 6 * HOUR;

const textOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();

/** The lines of a conversation a digest reads: the user's own words and the companion's answers. */
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
    this.idle = new Map();
    this.running = new Map();
    /** Notifications the phone should take back: reaches called off since it last asked. */
    this.calledOff = new Set();
  }

  /** The companion Bot a Session is the chat of, or undefined. */
  botOf(sessionId) {
    const owner = this.team.ownerOf(sessionId);
    if (owner?.kind !== 'bot') return undefined;
    const { botId } = this.open().companionSettings();
    return botId && owner.botId === botId ? botId : undefined;
  }

  /** The notes for a turn of the companion's chat (empty for anything else). */
  preStep({ agent, messages }) {
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string' || agent?.session?.header?.origin === 'subagent') return [];
    const botId = this.botOf(sessionId);
    if (!botId) return [];
    const store = this.open();
    const now = store.now();
    const zone = store.tzOffset;
    const said = userText(messages);
    const reach = messages.some((m) => m?.source?.kind === REACH_SOURCE);
    if (!said && !reach) return [];
    const target = sessionTarget(agent);
    if (target) store.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(`companion_target:${botId}`, JSON.stringify(target));
    const cursor = store.companionCursor(sessionId);
    const sections = [];
    if (!cursor.announced) {
      sections.push(...sessionSections({
        traits: standingTraits(store.companionTraits({ botId }), now),
        mood: recentMood(store.companionMoods({ botId }), now),
        now,
        tzOffset: zone,
      }));
      store.updateCompanionCursor(sessionId, { announced: true });
    }
    if (said) {
      const lastUserAt = store.companionLastUserAt(botId);
      for (const id of store.companionUserTurn(botId, REACH.answerHours * HOUR).cancelled) this.calledOff.add(id);
      // A break since the last turn: what came before is one conversation, digested now.
      if (cursor.lastTurnAt && now - cursor.lastTurnAt > GAP_MS) void this.digest(botId, agent);
      const episodes = store.companionEpisodes({ botId });
      const recalled = recallEpisodes(episodes, said, { now, shown: new Set(cursor.shown) });
      const thread = !lastUserAt || now - lastUserAt >= 3 * HOUR ? openThread(episodes, { now, tzOffset: zone }) : undefined;
      sections.push(...turnSections({ episodes: recalled, thread: thread && !recalled.some((e) => e.id === thread.id) ? thread : undefined, now, tzOffset: zone }));
      if (recalled.length) store.markRecalled(recalled.map((e) => e.id), sessionId);
      if (thread) store.markFollowedUp(thread.id);
      store.updateCompanionCursor(sessionId, { lastTurnAt: now });
      this.#armIdle(botId, agent);
    }
    return sections.length ? [noteOf(sections)] : [];
  }

  #armIdle(botId, agent) {
    const old = this.idle.get(botId);
    if (old) this.timers.clear(old);
    this.idle.set(botId, this.timers.set(() => { this.idle.delete(botId); void this.digest(botId, agent); }, IDLE_MS));
  }

  /** Turn what was said since the last digest into episodes, traits and mood. One per Bot at a time. */
  digest(botId, agent) {
    if (this.running.has(botId)) return this.running.get(botId);
    const run = this.#digest(botId, agent)
      .catch((error) => { this.logger?.warn?.(`companion: digest failed: ${error?.message ?? error}`); return { kept: 0, error: String(error?.message ?? error) }; })
      .finally(() => this.running.delete(botId));
    this.running.set(botId, run);
    return run;
  }

  async #digest(botId, agent) {
    const store = this.open();
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string') return { kept: 0, skipped: 'no-session' };
    let messages = [];
    try { messages = agent.session.deriveMessages?.() ?? []; } catch { return { kept: 0, skipped: 'unreadable' }; }
    const cursor = store.companionCursor(sessionId);
    const start = cursor.digested <= messages.length ? cursor.digested : messages.length;
    const lines = conversationLines(messages.slice(start));
    const said = lines.filter((l) => l.role === 'user').map((l) => l.text).join('');
    if ([...said].length < 15) {
      store.updateCompanionCursor(sessionId, { digested: messages.length });
      return { kept: 0, skipped: 'too-little' };
    }
    if (store.companionDigestsToday(botId) >= EPISODE.digestsPerDay) return { kept: 0, skipped: 'daily-limit' };
    const llm = this.get('llm');
    const target = sessionTarget(agent) ?? this.#savedTarget(botId);
    if (!llm || !target) return { kept: 0, skipped: 'no-model' };
    const now = store.now();
    const bot = this.team.bot(botId);
    const at = cursor.lastTurnAt ?? now;
    const user = `这段聊天发生在${whenSaid(at, now, store.tzOffset)}。\n\n${transcript(lines, { botName: bot?.name ?? '我' })}`;
    const answer = await this.callModel(llm, target, { system: DIGEST_SYSTEM, user, maxTokens: 1500 });
    store.countDigest(botId);
    const result = store.saveDigest({ botId, digest: parseDigest(answer), happenedAt: at });
    store.updateCompanionCursor(sessionId, { digested: messages.length });
    return { kept: result.episodes.length, hidden: result.hidden };
  }

  #savedTarget(botId) {
    try { return JSON.parse(this.open().db.prepare('SELECT value FROM meta WHERE key = ?').get(`companion_target:${botId}`)?.value ?? 'null') ?? undefined; } catch { return undefined; }
  }

  #agentOf(botId) {
    const sessionId = this.team.bot(botId)?.sessionId;
    if (!sessionId) return undefined;
    try { return this.agents?.get?.(sessionId) ?? undefined; } catch { return undefined; }
  }

  /**
   * The phone is going to the background: whether, when and what the companion says first.
   * A planned one is returned as it is (no new model call); a decision not to is kept for a while.
   * @returns {Promise<{ plan?: object, skip?: string }>}
   */
  async plan({ tzOffset, allowed = true } = {}) {
    const store = this.open();
    if (tzOffset !== undefined) store.useClock(tzOffset);
    const settings = store.companionSettings();
    if (!settings.botId) return { skip: 'no-companion' };
    if (!settings.reach) return { skip: 'off' };
    if (!allowed) return { skip: 'no-notifications' };
    const botId = settings.botId;
    const planned = store.companionReaches({ botId, status: 'planned', limit: 1 })[0];
    if (planned) return { plan: { ...planned, botName: this.team.bot(botId)?.name ?? '' } };
    const now = store.now();
    const checkedKey = `companion_plan_checked:${botId}`;
    const checked = Number(store.db.prepare('SELECT value FROM meta WHERE key = ?').get(checkedKey)?.value ?? 0);
    if (now - checked < PLAN_EVERY_MS) return { skip: 'thought-recently' };
    store.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(checkedKey, String(now));
    store.settleIgnoredReaches(botId, REACH.answerHours * HOUR);
    const last = store.companionReaches({ botId, limit: 5 }).find((r) => r.status !== 'cancelled');
    const decision = planReach({
      now, tzOffset: store.tzOffset, lastUserAt: store.companionLastUserAt(botId), lastReachAt: last?.fireAt,
      ignored: store.ignoredReaches(botId), quietStart: settings.quietStart, quietEnd: settings.quietEnd, random: this.random,
    });
    if (decision.skip) return { skip: decision.skip };
    const llm = this.get('llm');
    const target = this.#savedTarget(botId);
    if (!llm || !target) return { skip: 'no-model' };
    const bot = this.team.bot(botId);
    const recent = store.companionEpisodes({ botId, limit: 20 }).filter((e) => now - e.happenedAt <= 7 * 86_400_000).slice(0, 4);
    const user = openerPrompt({
      botName: bot?.name ?? 'Bot', persona: [bot?.role, bot?.instructions].filter(Boolean).join('\n'),
      traits: standingTraits(store.companionTraits({ botId }), now), episodes: recent, fireAt: decision.fireAt, tzOffset: store.tzOffset, now,
    });
    const text = parseOpener(await this.callModel(llm, target, { system: OPENER_SYSTEM, user, maxTokens: 200 }));
    if (!text) return { skip: 'nothing-to-say' };
    return { plan: { ...store.addReach({ botId, fireAt: decision.fireAt, text }), botName: bot?.name ?? '' } };
  }

  /**
   * The phone is in front again: a reach whose time has come is said in the companion's chat;
   * one too old is dropped; a conversation left idle is digested. Returns what the phone should
   * take off its notifications.
   */
  async wake({ tzOffset } = {}) {
    const store = this.open();
    if (tzOffset !== undefined) store.useClock(tzOffset);
    const { botId } = store.companionSettings();
    const out = { delivered: [], expired: [], cancelled: [...this.calledOff] };
    this.calledOff.clear();
    if (!botId) return out;
    const now = store.now();
    for (const reach of store.companionReaches({ botId, status: 'planned', limit: 5 })) {
      if (reach.fireAt > now) continue;
      if (now - reach.fireAt > REACH.staleHours * HOUR) {
        store.setReachStatus(reach.id, 'expired');
        out.expired.push(reach.id);
        continue;
      }
      const agent = this.#agentOf(botId) ?? await this.#resume(botId);
      if (!agent?.followup) continue;
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: reachText({ text: reach.text, fireAt: reach.fireAt, tzOffset: store.tzOffset }) }],
        source: { kind: REACH_SOURCE, reachId: reach.id },
      }));
      store.setReachStatus(reach.id, 'delivered');
      out.delivered.push(reach.id);
    }
    const agent = this.#agentOf(botId);
    const sessionId = agent?.session?.id;
    if (sessionId) {
      const cursor = store.companionCursor(sessionId);
      if (cursor.lastTurnAt && now - cursor.lastTurnAt > IDLE_MS) void this.digest(botId, agent);
    }
    return out;
  }

  async #resume(botId) {
    const sessionId = this.team.bot(botId)?.sessionId;
    const controller = this.get('sessionController');
    if (!sessionId || typeof controller?.resolveAgent !== 'function') return undefined;
    try { return await controller.resolveAgent(sessionId); } catch { return undefined; }
  }

  /** What the companion page shows. */
  status() {
    const store = this.open();
    const settings = store.companionSettings();
    const now = store.now();
    if (!settings.botId) return { settings, botName: null, traits: [], mood: null, episodes: 0, planned: null };
    const botId = settings.botId;
    return {
      settings,
      botName: this.team.bot(botId)?.name ?? null,
      traits: standingTraits(store.companionTraits({ botId }), now),
      mood: recentMood(store.companionMoods({ botId }), now) ?? null,
      episodes: store.companionEpisodes({ botId, limit: 2000 }).length,
      planned: store.companionReaches({ botId, status: 'planned', limit: 1 })[0] ?? null,
    };
  }

  /** Digest the companion's chat now (the page's 「现在整理」). */
  digestNow() {
    const { botId } = this.open().companionSettings();
    const agent = botId ? this.#agentOf(botId) : undefined;
    if (!agent) return Promise.resolve({ kept: 0, skipped: 'not-open' });
    return this.digest(botId, agent);
  }

  dispose() {
    for (const t of this.idle.values()) this.timers.clear(t);
    this.idle.clear();
  }
}
