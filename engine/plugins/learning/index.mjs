// Learning: the app's notebooks and the learner's long-term memory (store.mjs), offered
// to the app's own screens as JSON routes beside the engine's, the way the other iOS
// plugins offer theirs (ios-voice-message, ios-speech):
//
//   POST /api/learning/<method>   body: the method's parameters as a JSON object
//     → 200 { ok: true, result }
//     → 400 / 404 / 409 / 503 { error: { kind, message } }
//
// Methods (METHODS below): notebooks.list|get|create|update|delete,
// notes.list|get|create|update|delete|search, memories.list|get|create|update|delete|clear,
// and status (schema version, search mode, where the file is).
//
// The library opens on the first request, not at start-up, so an engine start never waits
// on it or fails because of it; it closes when the plugin is disposed.
import { LearningError, LearningStore, libraryFile, SCHEMA_VERSION } from './store.mjs';

export const ROUTE = '/api/learning';

/** method → what it does with the store and the request's parameters. */
export const METHODS = {
  status: (store) => ({ schemaVersion: store.version, latestSchemaVersion: SCHEMA_VERSION, search: store.fts }),
  'notebooks.list': (store) => store.listNotebooks(),
  'notebooks.get': (store, p) => store.getNotebook(p.id),
  'notebooks.create': (store, p) => store.createNotebook(p),
  'notebooks.update': (store, p) => store.updateNotebook(p),
  'notebooks.delete': (store, p) => store.deleteNotebook(p),
  'notes.list': (store, p) => store.listNotes(p),
  'notes.get': (store, p) => store.getNote(p),
  'notes.create': (store, p) => store.createNote(p),
  'notes.update': (store, p) => store.updateNote(p),
  'notes.delete': (store, p) => store.deleteNote(p),
  'notes.search': (store, p) => store.searchNotes(p),
  'memories.list': (store, p) => store.listMemories(p),
  'memories.get': (store, p) => store.getMemory(p),
  'memories.create': (store, p) => store.createMemory(p),
  'memories.update': (store, p) => store.updateMemory(p),
  'memories.delete': (store, p) => store.deleteMemory(p),
  'memories.clear': (store) => store.clearMemories(),
};

const STATUS = { invalid: 400, 'not-found': 404, conflict: 409, unavailable: 503 };

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** Answer one call: what the route sends back for `method` with `params`. */
export function call(open, method, params) {
  const run = METHODS[method];
  if (!run) return json({ error: { kind: 'invalid', message: `unknown method ${method}` } }, 404);
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return json({ error: { kind: 'invalid', message: 'the body must be a JSON object' } }, 400);
  }
  try {
    return json({ ok: true, result: run(open(), params) });
  } catch (error) {
    if (error instanceof LearningError) {
      return json({ error: { kind: error.kind, message: error.message } }, STATUS[error.kind] ?? 400);
    }
    return json({ error: { kind: 'internal', message: String(error?.message ?? error) } }, 500);
  }
}

export default class Learning {
  static inject = ['connection'];

  /**
   * @param {object} ctx
   * @param {{ file?: string, storeOptions?: object }} [config] - tests point `file` elsewhere.
   */
  constructor(ctx, config = {}) {
    let store;
    const open = () => {
      store ??= new LearningStore(config.file ?? libraryFile(), config.storeOptions);
      return store;
    };
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
          return call(open, method, params);
        },
      }), `learning: ${method}`);
    }
    ctx.effect(() => () => {
      store?.close();
      store = undefined;
    }, 'learning: library');
  }
}
