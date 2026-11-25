// Learning: the app's notebooks and the learner's long-term memory (store.mjs), the
// learning modes (modes.mjs) and the user's own skills (skills.mjs), offered to the app's
// own screens as JSON routes beside the engine's, the way the other iOS plugins offer
// theirs (ios-voice-message, ios-speech):
//
//   POST /api/learning/<method>   body: the method's parameters as a JSON object
//     → 200 { ok: true, result }
//     → 400 / 404 / 409 / 503 { error: { kind, message } }
//
// Methods (METHODS below): notebooks.list|get|create|update|delete,
// notes.list|get|create|update|delete|search, memories.list|get|create|update|delete|clear,
// status, and from M2 settings.get|update, modes.list, sessions.getMode|setMode|list,
// skills.list|get|create|update|delete.
//
// A session the app put in a learning mode gets, at the first step of each turn, one note
// with the mode's instructions and a few learning memories (modes.mjs). Other sessions are
// left exactly as they were. A failure there never stops the turn: the turn goes on without
// the note.
//
// The library opens on the first request (or the first step of a turn), not at start-up,
// so an engine start never waits on it or fails because of it; it closes when the plugin
// is disposed.
import { LearningError, LearningStore, libraryFile, SCHEMA_VERSION } from './store.mjs';
import { MODES, MODE_IDS, modeInstructions, noteMessage, noteSections, pickMemories, userTextOf } from './modes.mjs';
import { SkillFiles, skillsDir } from './skills.mjs';

export const ROUTE = '/api/learning';

/** method → what it does with the library (`store`), the skill folder (`skills`) and the parameters. */
export const METHODS = {
  status: ({ store }) => ({ schemaVersion: store.version, latestSchemaVersion: SCHEMA_VERSION, search: store.fts }),
  'notebooks.list': ({ store }) => store.listNotebooks(),
  'notebooks.get': ({ store }, p) => store.getNotebook(p.id),
  'notebooks.create': ({ store }, p) => store.createNotebook(p),
  'notebooks.update': ({ store }, p) => store.updateNotebook(p),
  'notebooks.delete': ({ store }, p) => store.deleteNotebook(p),
  'notes.list': ({ store }, p) => store.listNotes(p),
  'notes.get': ({ store }, p) => store.getNote(p),
  'notes.create': ({ store }, p) => store.createNote(p),
  'notes.update': ({ store }, p) => store.updateNote(p),
  'notes.delete': ({ store }, p) => store.deleteNote(p),
  'notes.search': ({ store }, p) => store.searchNotes(p),
  'memories.list': ({ store }, p) => store.listMemories(p),
  'memories.get': ({ store }, p) => store.getMemory(p),
  'memories.create': ({ store }, p) => store.createMemory(p),
  'memories.update': ({ store }, p) => store.updateMemory(p),
  'memories.delete': ({ store }, p) => store.deleteMemory(p),
  'memories.clear': ({ store }) => store.clearMemories(),
  'settings.get': ({ store }) => store.getSettings(),
  'settings.update': ({ store }, p) => store.updateSettings(p),
  'modes.list': () => MODE_IDS.map((id) => ({ id, skill: MODES[id].skill })),
  'sessions.getMode': ({ store }, p) => store.getSessionMode(p),
  'sessions.setMode': ({ store }, p) => store.setSessionMode(p),
  'sessions.list': ({ store }, p) => store.listSessionModes(p),
  'skills.list': ({ skills }) => skills().list(),
  'skills.get': ({ skills }, p) => skills().get(p),
  'skills.create': ({ skills }, p) => skills().create(p),
  'skills.update': ({ skills }, p) => skills().update(p),
  'skills.delete': ({ skills }, p) => skills().delete(p),
};

const STATUS = { invalid: 400, 'not-found': 404, conflict: 409, unavailable: 503 };

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/**
 * Answer one call: what the route sends back for `method` with `params`.
 * @param {() => LearningStore} open - the library, opened on first use.
 * @param {string} method
 * @param {object} params
 * @param {() => SkillFiles} [skills] - the skill folder.
 */
export function call(open, method, params, skills = () => new SkillFiles(skillsDir())) {
  const run = METHODS[method];
  if (!run) return json({ error: { kind: 'invalid', message: `unknown method ${method}` } }, 404);
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return json({ error: { kind: 'invalid', message: 'the body must be a JSON object' } }, 400);
  }
  try {
    const where = { skills };
    Object.defineProperty(where, 'store', { get: open });
    return json({ ok: true, result: run(where, params) ?? null });
  } catch (error) {
    if (error instanceof LearningError) {
      return json({ error: { kind: error.kind, message: error.message } }, STATUS[error.kind] ?? 400);
    }
    return json({ error: { kind: 'internal', message: String(error?.message ?? error) } }, 500);
  }
}

/**
 * The note for one turn of `sessionId`, or undefined when the session is not in a learning
 * mode. Marks the mode announced once its instructions are in a note.
 * @param {LearningStore} store
 * @param {string} sessionId
 * @param {readonly object[]} messages - the step's new messages.
 * @param {{ skillDir?: string }} [options]
 */
export function turnNote(store, sessionId, messages, options = {}) {
  const session = store.getSessionMode({ sessionId });
  if (!session) return undefined;
  const announce = session.announced !== session.mode;
  const instructions = announce ? modeInstructions(session.mode, options.skillDir) : undefined;
  const memories = store.getSettings().injectMemories
    ? pickMemories(store.recentMemories(), userTextOf(messages))
    : [];
  const message = noteMessage(noteSections({ mode: session.mode, announce, instructions, memories }));
  if (announce) store.markAnnounced({ sessionId, mode: session.mode });
  return message;
}

export default class Learning {
  static inject = ['connection', 'agents'];

  /**
   * @param {object} ctx
   * @param {{ file?: string, storeOptions?: object, skillsDir?: string, skillDir?: string }} [config]
   *   tests point `file` (the library), `skillsDir` (the user's skills) and `skillDir`
   *   (the bundled mode skills) elsewhere.
   */
  constructor(ctx, config = {}) {
    let store;
    const open = () => {
      store ??= new LearningStore(config.file ?? libraryFile(), config.storeOptions);
      return store;
    };
    const skills = () => new SkillFiles(config.skillsDir ?? skillsDir());
    for (const method of Object.keys(METHODS)) {
      ctx.effect(() => ctx.connection.fetch.register({
        path: `${ROUTE}/${method}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let params;
          try {
            const raw = await request.text();
            params = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            return json({ error: { kind: 'invalid', message: 'the body is not JSON' } }, 400);
          }
          return call(open, method, params, skills);
        },
      }), `learning: ${method}`);
    }

    // Only a turn's first step, and only one that brings new messages: a retry (no
    // messages) already has the note. Learning trouble never fails the turn.
    ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal?.aborted || step !== 1 || !decision.messages?.length) return decision;
      const sessionId = agent?.session?.id;
      if (typeof sessionId !== 'string' || !sessionId) return decision;
      let note;
      try {
        note = turnNote(open(), sessionId, decision.messages, { skillDir: config.skillDir });
      } catch (error) {
        ctx.logger?.warn?.(`learning: no note for this turn: ${error?.message ?? error}`);
        return decision;
      }
      return note ? { ...decision, messages: [...decision.messages, note] } : decision;
    });

    ctx.effect(() => () => {
      store?.close();
      store = undefined;
    }, 'learning: library');
  }
}
