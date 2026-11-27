// Who a DSH Session belongs to in the Bot team, read from ds-bot's own saved team
// (`$DSH_HOME/bot/state.json`, ds-bot 0.3.8 index.js). Read only, never written; re-read
// when the file changes. Anything missing or unreadable means "not a team Session", so a
// plain conversation (and everything learning did before) is never affected.
//
// ds-bot 0.3.8's shapes (src/host/store.js indexSessions):
// - bots[id].sessionId: the Bot's own chat, current part; bots[id].segments[].sessionId:
//   earlier parts; bots[id].openParts[].sessionId (+ .segments): parts opened while busy.
// - rooms[id].sessionId: the group's own Session (relays only, no model work of note);
//   rooms[id].parts[].sessionId: its earlier parts; rooms[id].members: Bot ids;
//   rooms[id].admin: the admin's Bot id or absent; rooms[id].mode: 'admin' | 'everyone';
//   rooms[id].sessions[botId]: each member's group Session in that room;
//   rooms[id].segments[botId][].sessionId: earlier parts of it.
// Values may be a string or { id }; sessionIdOf below takes both.
import fs from 'node:fs';
import path from 'node:path';

/** The team file under a DSH home. */
export const teamFile = (home) => path.join(home, 'bot', 'state.json');

const sessionIdOf = (value) => {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof value.id === 'string' && value.id) return value.id;
  return undefined;
};

/**
 * Index a saved team. Returns lookups by Session id:
 * - { kind: 'bot', botId }              a Bot's own chat (any part)
 * - { kind: 'member', botId, roomId }   a member's group Session (any part)
 * - { kind: 'room', roomId }            a group's own Session (any part)
 * and the Bots and rooms themselves (names, admin, members, mode).
 */
export function indexTeam(state) {
  const sessions = new Map();
  const bots = new Map();
  const rooms = new Map();
  const put = (id, owner) => { const sid = sessionIdOf(id); if (sid && !sessions.has(sid)) sessions.set(sid, owner); };
  const segmentsOf = (list) => (Array.isArray(list) ? list : []).map((s) => s?.sessionId ?? s);
  for (const [key, bot] of Object.entries(state?.bots ?? {})) {
    if (!bot || typeof bot !== 'object') continue;
    const botId = sessionIdOf(bot.id) ?? key;
    // Firefly 伙伴 (D55) reads the current Session, and the Bot's own description for its voice.
    bots.set(botId, {
      id: botId,
      name: typeof bot.name === 'string' ? bot.name : botId,
      sessionId: sessionIdOf(bot.sessionId),
      role: typeof bot.role === 'string' ? bot.role : '',
      instructions: typeof bot.instructions === 'string' ? bot.instructions.slice(0, 1200) : '',
    });
    const owner = { kind: 'bot', botId };
    put(bot.sessionId, owner);
    for (const s of segmentsOf(bot.segments)) put(s, owner);
    for (const part of Array.isArray(bot.openParts) ? bot.openParts : []) {
      put(part?.sessionId, owner);
      for (const s of segmentsOf(part?.segments)) put(s, owner);
    }
  }
  for (const [key, room] of Object.entries(state?.rooms ?? {})) {
    if (!room || typeof room !== 'object') continue;
    const roomId = sessionIdOf(room.id) ?? key;
    const members = (Array.isArray(room.members) ? room.members : []).map((m) => sessionIdOf(m)).filter(Boolean);
    const admin = sessionIdOf(room.admin);
    rooms.set(roomId, {
      id: roomId,
      name: typeof room.name === 'string' ? room.name : roomId,
      members,
      admin: admin && members.includes(admin) ? admin : undefined,
      mode: admin ? (room.mode === 'everyone' ? 'everyone' : 'admin') : 'everyone',
    });
    for (const [botId, sid] of Object.entries(room.sessions ?? {})) put(sid, { kind: 'member', botId, roomId });
    for (const [botId, list] of Object.entries(room.segments ?? {})) for (const s of segmentsOf(list)) put(s, { kind: 'member', botId, roomId });
    const own = { kind: 'room', roomId };
    put(room.sessionId ?? roomId, own);
    for (const s of segmentsOf(room.parts)) put(s, own);
  }
  return { sessions, bots, rooms };
}

const EMPTY = Object.freeze({ sessions: new Map(), bots: new Map(), rooms: new Map() });

/** The team as it is now, re-read only when the file changed. */
export class TeamIndex {
  /** @param {() => string} file */
  constructor(file) {
    this.file = file;
    this.stamp = '';
    this.index = EMPTY;
  }

  current() {
    let stat;
    try { stat = fs.statSync(this.file()); } catch { this.stamp = ''; this.index = EMPTY; return this.index; }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (stamp === this.stamp) return this.index;
    try {
      this.index = indexTeam(JSON.parse(fs.readFileSync(this.file(), 'utf8')));
    } catch {
      this.index = EMPTY;
    }
    this.stamp = stamp;
    return this.index;
  }

  /** What `sessionId` is in the team, or undefined for a plain conversation. */
  ownerOf(sessionId) {
    return typeof sessionId === 'string' ? this.current().sessions.get(sessionId) : undefined;
  }

  bot(botId) { return this.current().bots.get(botId); }
  room(roomId) { return this.current().rooms.get(roomId); }
}

/**
 * The learning owner a Session's mode is kept on: a Bot's chat follows the Bot, a member's
 * group Session follows the group, anything else is its own. A group's own Session is
 * 'relay': it gets nothing.
 */
export function learningOwner(team, sessionId) {
  const found = team?.ownerOf?.(sessionId);
  if (!found) return { kind: 'session', id: sessionId };
  if (found.kind === 'bot') return { kind: 'bot', id: found.botId };
  if (found.kind === 'member') return { kind: 'room', id: found.roomId, botId: found.botId };
  return { kind: 'relay', id: found.roomId };
}

/** The key that groups a research job's Sessions: one research at a time per key. */
export function ownerKey(team, sessionId) {
  const owner = learningOwner(team, sessionId);
  return owner.kind === 'relay' ? `room:${owner.id}` : `${owner.kind}:${owner.id}`;
}

// ds-bot's relays (source.kind 'bot', form 'relay'): which of their roles are the learner's
// own turn, per kind of Session (ds-bot 0.3.8 delivery.js headerFor). In a Bot's chat a
// request/reply/report is another Bot's errand; in a group the round ('room') and the
// answers to one's own post ('report') are the lesson.
const LEARNING_ROLES = {
  bot: new Set(['continue', 'resume']),
  room: new Set(['room', 'report', 'continue', 'resume']),
};

/**
 * Whether a turn bringing `messages` is one the learning mode applies to. A plain
 * conversation: anything but a scheduled reminder. A Bot's chat or a group: the user's own
 * messages and the relays above; never a reminder, a kickoff, a profile update, a goal or
 * another Bot's errand.
 */
export function learningTurn(ownerKind, messages) {
  for (const message of messages ?? []) {
    if (message?.role !== 'user') continue;
    const source = message.source ?? { kind: 'user' };
    if (source.kind === 'schedule') continue;
    if (ownerKind === 'session') return true;
    if (source.kind === 'user') return true;
    if (source.kind === 'bot' && source.form === 'relay' && LEARNING_ROLES[ownerKind]?.has(source.role)) return true;
  }
  return false;
}
