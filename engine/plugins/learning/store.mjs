// The learning library: notebooks, notes and the learner's long-term memory, in one
// SQLite file of its own (node:sqlite, the same stack as DSH's session search).
//
// Where it lives: `$DSH_HOME/learning/learning.db`, one folder below `$DSH_HOME`. The
// engine's recovery (runtime/recovery.mjs) treats every small file directly in
// `$DSH_HOME` and in `profiles/web` as a setting, checkpoints it at each start, puts it
// back on "restore" and moves it away on "reset". A database there would be rolled back
// or moved away with the settings, so it must stay in a folder of its own.
//
// It never touches what DSH or ds-bot keep (sessions, Bot memory in MEMORY.md): clearing
// the learning memory clears this file's `memories` table and nothing else.
//
// All SQL lives in this file. Callers get plain objects with camelCase fields.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { blobToVector, chunkText, citationOf, cosine, fuseRanks, vectorToBlob } from './kb.mjs';

/** `PRAGMA application_id`: 'LRN1'. DSH's session search uses 1146308689; this must differ. */
export const APPLICATION_ID = 0x4c524e31;
/** Limits on what one request may store. */
export const LIMITS = {
  title: 200, body: 1_000_000, memory: 4_000, query: 200, page: 200,
  // M3: one imported document, a model name, a vector, one vectors.put call.
  document: 5_000_000, model: 200, dims: 4_096, vectorBatch: 256,
};

/** The database file under `$DSH_HOME`. */
export function libraryFile(home = process.env.DSH_HOME) {
  if (!home) throw new LearningError('unavailable', 'DSH_HOME is not set');
  return path.join(home, 'learning', 'learning.db');
}

export class LearningError extends Error {
  /** @param {'invalid'|'not-found'|'unavailable'|'conflict'|'unsupported'} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/**
 * The schema, one step per version. A step only adds; it never drops or rewrites what
 * an earlier step made, so every older library opens with its data intact.
 * Step 2 builds the full-text index; it is optional (see `fts`).
 */
export const MIGRATIONS = [
  // 1: tables.
  (db) => {
    db.exec(`
      CREATE TABLE notebooks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY,
        notebook_id INTEGER NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX notes_by_notebook ON notes(notebook_id, updated_at DESC);
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX memories_by_time ON memories(updated_at DESC);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
  },
  // 2: full-text index over notes, trigram so Chinese can be searched by substring.
  // Without trigram (an SQLite built without it) the step records that and search
  // falls back to LIKE; the version still advances, so the library stays usable.
  (db, options) => {
    let fts = 'none';
    if (options.fts !== false) {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE notes_fts USING fts5(
            title, body, content='notes', content_rowid='id', tokenize='trigram'
          );
          CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
          END;
          CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
          END;
          CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
            INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
          END;
          INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');
        `);
        fts = 'trigram';
      } catch (error) {
        if (!/no such tokenizer|no such module/i.test(String(error?.message))) throw error;
      }
    }
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('fts', fts);
  },
  // 3 (M2): the learning mode of each session the app started in one. Only the DSH session
  // id is kept, never the conversation. `announced` is the mode whose full instructions the
  // session has already been given; it is cleared whenever the mode changes.
  (db) => {
    db.exec(`
      CREATE TABLE session_modes (
        session_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('qa', 'socratic', 'quiz')),
        announced TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  },
  // 4 (M3): the light knowledge base. A document is kept as its chunks (the text cut with
  // overlap, kb.mjs chunkText), never as a file; vectors, one per chunk and model, are made
  // by the app and stored as float32 BLOBs. Full-text over chunks is trigram like notes',
  // optional the same way (meta kb_fts).
  (db, options) => {
    db.exec(`
      CREATE TABLE kb_documents (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('txt', 'md', 'pdf')),
        source_name TEXT NOT NULL DEFAULT '',
        chars INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        -- BCP-47 code the engine detected (for Apple's per-language embedding), '' until then.
        language TEXT NOT NULL DEFAULT '',
        -- Apple embedding: '' not tried yet, 'ok', 'unavailable' (no sentence embedding for
        -- for the language on this device), 'failed'.
        embedding_status TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE kb_chunks (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        heading TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        UNIQUE (document_id, ordinal)
      ) STRICT;
      CREATE TABLE kb_vectors (
        chunk_id INTEGER NOT NULL REFERENCES kb_chunks(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (chunk_id, model)
      ) STRICT;
      CREATE INDEX kb_vectors_by_model ON kb_vectors(model);
    `);
    let fts = 'none';
    if (options.fts !== false) {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
            heading, text, content='kb_chunks', content_rowid='id', tokenize='trigram'
          );
          CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
            INSERT INTO kb_chunks_fts(rowid, heading, text) VALUES (new.id, new.heading, new.text);
          END;
          CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
            INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, heading, text) VALUES ('delete', old.id, old.heading, old.text);
          END;
        `);
        fts = 'trigram';
      } catch (error) {
        if (!/no such tokenizer|no such module/i.test(String(error?.message))) throw error;
      }
    }
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('kb_fts', fts);
  },
];
export const SCHEMA_VERSION = MIGRATIONS.length;

const codepoints = (text) => [...text].length;

function text(value, field, max, { required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw new LearningError('invalid', `${field} must be a string`);
  if (codepoints(value) > max) throw new LearningError('invalid', `${field} is longer than ${max} characters`);
  return value;
}

function id(value, field = 'id') {
  if (!Number.isSafeInteger(value) || value <= 0) throw new LearningError('invalid', `${field} must be a positive integer`);
  return value;
}

const notebookRow = (row) => row && ({
  id: row.id, title: row.title, noteCount: row.note_count ?? 0, createdAt: row.created_at, updatedAt: row.updated_at,
});
const noteRow = (row) => row && ({
  id: row.id, notebookId: row.notebook_id, title: row.title, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at,
});
const memoryRow = (row) => row && ({
  id: row.id, content: row.content, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at,
});

/** Up to `size` characters of `body` around the first place one of `terms` occurs. */
export function excerpt(body, terms, size = 80) {
  const chars = [...body];
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term.toLowerCase());
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = at < 0 ? 0 : Math.max(0, codepoints(body.slice(0, at)) - Math.floor(size / 4));
  const piece = chars.slice(start, start + size).join('');
  return (start > 0 ? '…' : '') + piece + (start + size < chars.length ? '…' : '');
}

/** The words of a query: split on whitespace, empty ones dropped, at most 8. */
export function queryTerms(query) {
  return query.trim().split(/\s+/u).filter(Boolean).slice(0, 8);
}

export class LearningStore {
  /**
   * @param {string} file - the database, or ':memory:'.
   * @param {{ now?: () => number, fts?: boolean }} [options] - `fts: false` builds no
   *   full-text index (what an SQLite without trigram ends up with); `now` for tests.
   */
  constructor(file, options = {}) {
    this.file = file;
    this.now = options.now ?? Date.now;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA foreign_keys = ON');
      // Check what the file is before changing anything about it: switching to WAL
      // rewrites the header, and a file that is not ours must be left as it was.
      this.#migrate(options);
      if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  #migrate(options) {
    const { application_id: appId } = this.db.prepare('PRAGMA application_id').get();
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get();
    if (appId !== 0 && appId !== APPLICATION_ID) {
      throw new LearningError('conflict', `${this.file} is not a learning library (application_id ${appId})`);
    }
    if (appId === 0) {
      const tables = this.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get().n;
      if (tables > 0) throw new LearningError('conflict', `${this.file} holds tables that are not a learning library's`);
    }
    if (version > SCHEMA_VERSION) {
      throw new LearningError('conflict', `${this.file} is schema ${version}, newer than this app's ${SCHEMA_VERSION}`);
    }
    for (let step = version; step < SCHEMA_VERSION; step += 1) {
      this.transaction(() => {
        MIGRATIONS[step](this.db, options);
        this.db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${step + 1}`);
      });
    }
  }

  get version() { return this.db.prepare('PRAGMA user_version').get().user_version; }

  /** 'trigram' when notes have a full-text index, 'none' when search scans with LIKE. */
  get fts() { return this.db.prepare("SELECT value FROM meta WHERE key = 'fts'").get()?.value ?? 'none'; }

  /** Run `work` in one transaction: all of it is kept, or none of it if it throws. */
  transaction(work) {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() { if (this.db.isOpen) this.db.close(); }

  // Notebooks

  listNotebooks() {
    return this.db.prepare(`
      SELECT b.*, (SELECT count(*) FROM notes n WHERE n.notebook_id = b.id) AS note_count
      FROM notebooks b ORDER BY b.updated_at DESC, b.id DESC
    `).all().map(notebookRow);
  }

  getNotebook(notebookId) {
    const row = this.db.prepare(`
      SELECT b.*, (SELECT count(*) FROM notes n WHERE n.notebook_id = b.id) AS note_count
      FROM notebooks b WHERE b.id = ?
    `).get(id(notebookId));
    if (!row) throw new LearningError('not-found', `no notebook ${notebookId}`);
    return notebookRow(row);
  }

  createNotebook({ title }) {
    const name = text(title, 'title', LIMITS.title).trim();
    if (!name) throw new LearningError('invalid', 'title is empty');
    const now = this.now();
    const { lastInsertRowid } = this.db.prepare(
      'INSERT INTO notebooks(title, created_at, updated_at) VALUES (?, ?, ?)',
    ).run(name, now, now);
    return this.getNotebook(Number(lastInsertRowid));
  }

  updateNotebook({ id: notebookId, title }) {
    const name = text(title, 'title', LIMITS.title).trim();
    if (!name) throw new LearningError('invalid', 'title is empty');
    const { changes } = this.db.prepare('UPDATE notebooks SET title = ?, updated_at = ? WHERE id = ?')
      .run(name, this.now(), id(notebookId));
    if (!changes) throw new LearningError('not-found', `no notebook ${notebookId}`);
    return this.getNotebook(notebookId);
  }

  /** Deletes the notebook and every note in it. */
  deleteNotebook({ id: notebookId }) {
    const { changes } = this.db.prepare('DELETE FROM notebooks WHERE id = ?').run(id(notebookId));
    if (!changes) throw new LearningError('not-found', `no notebook ${notebookId}`);
    return { deleted: true };
  }

  // Notes

  listNotes({ notebookId, limit = 100, offset = 0 }) {
    this.getNotebook(notebookId);
    const page = Math.min(Math.max(1, Number(limit) || 100), LIMITS.page);
    return this.db.prepare(`
      SELECT * FROM notes WHERE notebook_id = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(notebookId, page, Math.max(0, Number(offset) || 0)).map(noteRow);
  }

  getNote({ id: noteId }) {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id(noteId));
    if (!row) throw new LearningError('not-found', `no note ${noteId}`);
    return noteRow(row);
  }

  createNote({ notebookId, title = '', body = '' }) {
    text(title, 'title', LIMITS.title);
    text(body, 'body', LIMITS.body);
    return this.transaction(() => {
      this.getNotebook(notebookId);
      const now = this.now();
      const { lastInsertRowid } = this.db.prepare(
        'INSERT INTO notes(notebook_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(notebookId, title, body, now, now);
      this.db.prepare('UPDATE notebooks SET updated_at = ? WHERE id = ?').run(now, notebookId);
      return this.getNote({ id: Number(lastInsertRowid) });
    });
  }

  updateNote({ id: noteId, title, body }) {
    text(title, 'title', LIMITS.title, { required: false });
    text(body, 'body', LIMITS.body, { required: false });
    return this.transaction(() => {
      const note = this.getNote({ id: noteId });
      const now = this.now();
      this.db.prepare('UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?')
        .run(title ?? note.title, body ?? note.body, now, noteId);
      this.db.prepare('UPDATE notebooks SET updated_at = ? WHERE id = ?').run(now, note.notebookId);
      return this.getNote({ id: noteId });
    });
  }

  deleteNote({ id: noteId }) {
    const { changes } = this.db.prepare('DELETE FROM notes WHERE id = ?').run(id(noteId));
    if (!changes) throw new LearningError('not-found', `no note ${noteId}`);
    return { deleted: true };
  }

  /**
   * Notes whose title or body holds every word of `query`, best first.
   * Trigram matches substrings of three characters or more, so a query with a shorter
   * word (most two-character Chinese words: 函数) scans with LIKE instead; so does every
   * query when the library has no full-text index.
   */
  searchNotes({ query, notebookId, limit = 50 }) {
    const terms = queryTerms(text(query, 'query', LIMITS.query));
    if (!terms.length) return { mode: 'none', results: [] };
    if (notebookId !== undefined) id(notebookId, 'notebookId');
    const page = Math.min(Math.max(1, Number(limit) || 50), LIMITS.page);
    const inBook = notebookId === undefined ? '' : ' AND n.notebook_id = ?';
    const extra = notebookId === undefined ? [] : [notebookId];
    let rows;
    let mode;
    if (this.fts === 'trigram' && terms.every((term) => codepoints(term) >= 3)) {
      mode = 'fts';
      const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
      rows = this.db.prepare(`
        SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.rowid
        WHERE notes_fts MATCH ?${inBook} ORDER BY bm25(notes_fts), n.updated_at DESC LIMIT ?
      `).all(match, ...extra, page);
    } else {
      mode = 'like';
      const escape = (term) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const where = terms.map(() => "(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\')").join(' AND ');
      const args = terms.flatMap((term) => [escape(term), escape(term)]);
      rows = this.db.prepare(`
        SELECT n.* FROM notes n WHERE ${where}${inBook} ORDER BY n.updated_at DESC, n.id DESC LIMIT ?
      `).all(...args, ...extra, page);
    }
    return {
      mode,
      results: rows.map((row) => ({
        id: row.id, notebookId: row.notebook_id, title: row.title, excerpt: excerpt(row.body, terms), updatedAt: row.updated_at,
      })),
    };
  }

  // Memories (the learner's long-term memory; not ds-bot's MEMORY.md)

  listMemories({ limit = 200, offset = 0 } = {}) {
    const page = Math.min(Math.max(1, Number(limit) || 200), LIMITS.page);
    return this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(page, Math.max(0, Number(offset) || 0)).map(memoryRow);
  }

  getMemory({ id: memoryId }) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id(memoryId));
    if (!row) throw new LearningError('not-found', `no memory ${memoryId}`);
    return memoryRow(row);
  }

  createMemory({ content, source = 'user' }) {
    const value = text(content, 'content', LIMITS.memory).trim();
    if (!value) throw new LearningError('invalid', 'content is empty');
    if (!['user', 'agent'].includes(source)) throw new LearningError('invalid', "source must be 'user' or 'agent'");
    const now = this.now();
    const { lastInsertRowid } = this.db.prepare(
      'INSERT INTO memories(content, source, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(value, source, now, now);
    return this.getMemory({ id: Number(lastInsertRowid) });
  }

  updateMemory({ id: memoryId, content }) {
    const value = text(content, 'content', LIMITS.memory).trim();
    if (!value) throw new LearningError('invalid', 'content is empty');
    const { changes } = this.db.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?')
      .run(value, this.now(), id(memoryId));
    if (!changes) throw new LearningError('not-found', `no memory ${memoryId}`);
    return this.getMemory({ id: memoryId });
  }

  deleteMemory({ id: memoryId }) {
    const { changes } = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id(memoryId));
    if (!changes) throw new LearningError('not-found', `no memory ${memoryId}`);
    return { deleted: true };
  }

  /** Every learning memory, and nothing else: notes, notebooks and Bot memory stay. */
  clearMemories() {
    const { changes } = this.db.prepare('DELETE FROM memories').run();
    return { deleted: Number(changes) };
  }

  /** The newest `limit` memories, for picking what a turn gets (modes.mjs pickMemories). */
  recentMemories(limit = 500) {
    return this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC, id DESC LIMIT ?')
      .all(Math.max(1, Math.min(Number(limit) || 500, 5_000))).map(memoryRow);
  }

  // Settings (M2): kept in `meta`, inside the learning library, so the engine's settings
  // reset never moves them away and deleting learning data takes them too.

  getSettings() {
    const value = (key) => this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
    return { injectMemories: value('inject_memories') !== 'off', appleEmbedding: value('kb_apple_embedding') !== 'off' };
  }

  /** Change the settings given; the rest keep their value. */
  updateSettings({ injectMemories, appleEmbedding }) {
    const changes = [['inject_memories', injectMemories, 'injectMemories'], ['kb_apple_embedding', appleEmbedding, 'appleEmbedding']]
      .filter(([, value]) => value !== undefined);
    if (!changes.length) throw new LearningError('invalid', 'nothing to change: pass injectMemories or appleEmbedding');
    for (const [, value, name] of changes) {
      if (typeof value !== 'boolean') throw new LearningError('invalid', `${name} must be true or false`);
    }
    const put = this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
    for (const [key, value] of changes) put.run(key, value ? 'on' : 'off');
    return this.getSettings();
  }

  // Session modes (M2)

  /** The learning mode of a session, or null for a session the app did not start in one. */
  getSessionMode({ sessionId }) {
    const row = this.db.prepare('SELECT * FROM session_modes WHERE session_id = ?').get(sessionKey(sessionId));
    return row ? { sessionId: row.session_id, mode: row.mode, announced: row.announced ?? null, updatedAt: row.updated_at } : null;
  }

  /** Put a session in `mode`, or take it out of learning with `mode: null`. */
  setSessionMode({ sessionId, mode }) {
    const key = sessionKey(sessionId);
    if (mode === null) {
      this.db.prepare('DELETE FROM session_modes WHERE session_id = ?').run(key);
      return null;
    }
    if (!SESSION_MODES.includes(mode)) throw new LearningError('invalid', `mode must be one of ${SESSION_MODES.join(', ')} or null`);
    this.db.prepare(`
      INSERT INTO session_modes(session_id, mode, announced, updated_at) VALUES (?, ?, NULL, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        announced = CASE WHEN session_modes.mode = excluded.mode THEN session_modes.announced ELSE NULL END,
        mode = excluded.mode,
        updated_at = excluded.updated_at
    `).run(key, mode, this.now());
    return this.getSessionMode({ sessionId: key });
  }

  /** Record that the session has been given `mode`'s full instructions. */
  markAnnounced({ sessionId, mode }) {
    this.db.prepare('UPDATE session_modes SET announced = ? WHERE session_id = ? AND mode = ?')
      .run(mode, sessionKey(sessionId), mode);
  }

  /** The sessions in a learning mode, most recently set first. */
  listSessionModes({ limit = 100 } = {}) {
    const page = Math.min(Math.max(1, Number(limit) || 100), LIMITS.page);
    return this.db.prepare('SELECT * FROM session_modes ORDER BY updated_at DESC, session_id LIMIT ?').all(page)
      .map((row) => ({ sessionId: row.session_id, mode: row.mode, announced: row.announced ?? null, updatedAt: row.updated_at }));
  }

  // Knowledge base (M3)

  /** 'trigram' when chunks have a full-text index, 'none' when keyword search scans with LIKE. */
  get kbFts() { return this.db.prepare("SELECT value FROM meta WHERE key = 'kb_fts'").get()?.value ?? 'none'; }

  listDocuments() {
    return this.db.prepare('SELECT * FROM kb_documents ORDER BY updated_at DESC, id DESC').all().map(documentRow);
  }

  getDocument({ id: documentId }) {
    const row = this.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(id(documentId));
    if (!row) throw new LearningError('not-found', `no document ${documentId}`);
    return documentRow(row);
  }

  /**
   * Store a document as its chunks. `text` is the document's text: the file itself for
   * txt and md, what the app extracted with PDFKit for a pdf. A pdf with no text (a scan)
   * is refused as `unsupported`: reading scans needs a cloud parser, which is not built.
   */
  importDocument({ title, kind, text: body, sourceName = '' }) {
    const name = text(title, 'title', LIMITS.title).trim();
    if (!name) throw new LearningError('invalid', 'title is empty');
    if (!DOCUMENT_KINDS.includes(kind)) throw new LearningError('invalid', `kind must be one of ${DOCUMENT_KINDS.join(', ')}`);
    text(sourceName, 'sourceName', LIMITS.title);
    const content = text(body, 'text', LIMITS.document).replace(/\r\n?/g, '\n');
    if (!content.trim()) {
      if (kind === 'pdf') throw new LearningError('unsupported', 'this PDF has no text layer (a scan?); reading scanned PDFs is not supported yet');
      throw new LearningError('invalid', 'the document has no text');
    }
    const chunks = chunkText(content, { markdown: kind === 'md' });
    return this.transaction(() => {
      const now = this.now();
      const { lastInsertRowid } = this.db.prepare(`
        INSERT INTO kb_documents(title, kind, source_name, chars, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(name, kind, sourceName, codepoints(content), chunks.length, now, now);
      const documentId = Number(lastInsertRowid);
      const insert = this.db.prepare(
        'INSERT INTO kb_chunks(document_id, ordinal, start, end, heading, text) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const chunk of chunks) insert.run(documentId, chunk.ordinal, chunk.start, chunk.end, chunk.heading, chunk.text);
      return this.getDocument({ id: documentId });
    });
  }

  /** Deletes the document, its chunks and their vectors. */
  deleteDocument({ id: documentId }) {
    const { changes } = this.db.prepare('DELETE FROM kb_documents WHERE id = ?').run(id(documentId));
    if (!changes) throw new LearningError('not-found', `no document ${documentId}`);
    return { deleted: true };
  }

  getChunk({ id: chunkId }) {
    const row = this.db.prepare(`
      SELECT c.*, d.title AS document_title, d.chunk_count FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
      WHERE c.id = ?
    `).get(id(chunkId));
    if (!row) throw new LearningError('not-found', `no chunk ${chunkId}`);
    return chunkHit(row);
  }

  /**
   * Chunks that have no vector for `model` yet (or, with `modelPrefix`, for any model
   * starting with it), oldest first, for whoever makes vectors. `documentId` narrows it.
   */
  pendingVectors({ model, modelPrefix, documentId, limit = 64 }) {
    const page = Math.min(Math.max(1, Number(limit) || 64), LIMITS.vectorBatch);
    let match;
    let key;
    if (modelPrefix !== undefined) {
      key = `${modelName(modelPrefix).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      match = "v.model LIKE ? ESCAPE '\\'";
    } else {
      key = modelName(model);
      match = 'v.model = ?';
    }
    const inDoc = documentId === undefined ? '' : ' AND c.document_id = ?';
    const extra = documentId === undefined ? [] : [id(documentId, 'documentId')];
    return this.db.prepare(`
      SELECT c.id, c.text FROM kb_chunks c
      WHERE NOT EXISTS (SELECT 1 FROM kb_vectors v WHERE v.chunk_id = c.id AND ${match})${inDoc}
      ORDER BY c.id LIMIT ?
    `).all(key, ...extra, page).map((row) => ({ chunkId: row.id, text: row.text }));
  }

  /** Record what the engine found out about a document for Apple's embedding. */
  setDocumentEmbedding({ id: documentId, language, status }) {
    if (language !== undefined && (typeof language !== 'string' || language.length > 35)) {
      throw new LearningError('invalid', 'language must be a BCP-47 code');
    }
    if (status !== undefined && !['', 'ok', 'unavailable', 'failed'].includes(status)) {
      throw new LearningError('invalid', 'status must be "", ok, unavailable or failed');
    }
    const current = this.getDocument({ id: documentId });
    this.db.prepare('UPDATE kb_documents SET language = ?, embedding_status = ? WHERE id = ?')
      .run(language ?? current.language, status ?? current.embeddingStatus, documentId);
    return this.getDocument({ id: documentId });
  }

  /** Documents whose chunks still lack an Apple vector and that are worth trying. */
  documentsToEmbed(prefix) {
    const key = `${modelName(prefix).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db.prepare(`
      SELECT d.* FROM kb_documents d
      WHERE d.embedding_status NOT IN ('unavailable', 'failed') AND EXISTS (
        SELECT 1 FROM kb_chunks c WHERE c.document_id = d.id AND NOT EXISTS (
          SELECT 1 FROM kb_vectors v WHERE v.chunk_id = c.id AND v.model LIKE ? ESCAPE '\\'))
      ORDER BY d.id
    `).all(key).map(documentRow);
  }

  /** The models that have vectors, with their length. */
  vectorModels() {
    return this.db.prepare('SELECT model, dims FROM kb_vectors GROUP BY model, dims ORDER BY model').all()
      .map((row) => ({ model: row.model, dims: row.dims }));
  }

  /**
   * Store vectors made by `model`. Every vector of one model has the same length; the
   * first stored fixes it. A chunk deleted meanwhile is skipped, not an error.
   */
  putVectors({ model, items }) {
    const key = modelName(model);
    if (!Array.isArray(items) || items.length > LIMITS.vectorBatch) {
      throw new LearningError('invalid', `items must be an array of at most ${LIMITS.vectorBatch}`);
    }
    return this.transaction(() => {
      let dims = this.db.prepare('SELECT dims FROM kb_vectors WHERE model = ? LIMIT 1').get(key)?.dims;
      const exists = this.db.prepare('SELECT 1 FROM kb_chunks WHERE id = ?');
      const put = this.db.prepare('INSERT OR REPLACE INTO kb_vectors(chunk_id, model, dims, vector) VALUES (?, ?, ?, ?)');
      let stored = 0;
      for (const item of items) {
        const chunkId = id(item?.chunkId, 'chunkId');
        const vector = item?.vector;
        if (!Array.isArray(vector) || !vector.length || vector.length > LIMITS.dims) {
          throw new LearningError('invalid', `vector must be an array of 1 to ${LIMITS.dims} numbers`);
        }
        dims ??= vector.length;
        if (vector.length !== dims) throw new LearningError('invalid', `${key} vectors have ${dims} dimensions, not ${vector.length}`);
        let blob;
        try { blob = vectorToBlob(vector); } catch (error) { throw new LearningError('invalid', error.message); }
        if (!exists.get(chunkId)) continue;
        put.run(chunkId, key, dims, blob);
        stored += 1;
      }
      return { stored, dims: dims ?? null };
    });
  }

  /** Vector coverage per model: how many chunks have one, out of all chunks. */
  vectorStatus() {
    const chunks = this.db.prepare('SELECT count(*) AS n FROM kb_chunks').get().n;
    const models = this.db.prepare('SELECT model, dims, count(*) AS n FROM kb_vectors GROUP BY model, dims ORDER BY model').all()
      .map((row) => ({ model: row.model, dims: row.dims, chunks: row.n }));
    return { chunks, models };
  }

  /** Forget every vector of `model` (a model the user no longer uses, or one that changed). */
  clearVectors({ model }) {
    const { changes } = this.db.prepare('DELETE FROM kb_vectors WHERE model = ?').run(modelName(model));
    return { deleted: Number(changes) };
  }

  /**
   * Chunks for `query`, best first, each with its citation. Keyword search always runs
   * (trigram FTS when every word has three characters or more, LIKE otherwise, the same
   * rule as notes). When `vector` and `model` are given and chunks have vectors for that
   * model, a cosine ranking runs too and the two are fused by reciprocal rank.
   */
  searchKnowledge({ query, vector, model, queryVectors, documentIds, limit = 8 }) {
    const terms = queryTerms(text(query, 'query', LIMITS.query));
    const page = Math.min(Math.max(1, Number(limit) || 8), 50);
    let inDocs = '';
    let docArgs = [];
    if (documentIds !== undefined) {
      if (!Array.isArray(documentIds) || documentIds.length > 200) throw new LearningError('invalid', 'documentIds must be an array of at most 200 ids');
      docArgs = documentIds.map((value) => id(value, 'documentIds'));
      if (!docArgs.length) return { mode: 'none', results: [] };
      inDocs = ` AND c.document_id IN (${docArgs.map(() => '?').join(', ')})`;
    }
    const pool = 50;
    let keyword = [];
    let keywordMode = 'none';
    if (terms.length) {
      if (this.kbFts === 'trigram' && terms.every((term) => codepoints(term) >= 3)) {
        keywordMode = 'fts';
        const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
        keyword = this.db.prepare(`
          SELECT c.id FROM kb_chunks_fts f JOIN kb_chunks c ON c.id = f.rowid
          WHERE kb_chunks_fts MATCH ?${inDocs} ORDER BY bm25(kb_chunks_fts), c.id LIMIT ?
        `).all(match, ...docArgs, pool).map((row) => row.id);
      } else {
        keywordMode = 'like';
        const escape = (term) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const where = terms.map(() => "(c.text LIKE ? ESCAPE '\\' OR c.heading LIKE ? ESCAPE '\\')").join(' AND ');
        keyword = this.db.prepare(`SELECT c.id FROM kb_chunks c WHERE ${where}${inDocs} ORDER BY c.document_id, c.ordinal LIMIT ?`)
          .all(...terms.flatMap((term) => [escape(term), escape(term)]), ...docArgs, pool).map((row) => row.id);
      }
    }
    let semantic = [];
    const queries = [];
    if (vector !== undefined) queries.push({ model, vector });
    if (queryVectors !== undefined) {
      if (!Array.isArray(queryVectors) || queryVectors.length > 8) throw new LearningError('invalid', 'queryVectors must be an array of at most 8');
      queries.push(...queryVectors);
    }
    const rankings = [];
    for (const entry of queries) {
      const key = modelName(entry?.model);
      if (!Array.isArray(entry.vector) || !entry.vector.length) throw new LearningError('invalid', 'vector must be a non-empty array of numbers');
      const query32 = Float32Array.from(entry.vector, Number);
      const rows = this.db.prepare(`
        SELECT v.chunk_id, v.dims, v.vector FROM kb_vectors v JOIN kb_chunks c ON c.id = v.chunk_id WHERE v.model = ?${inDocs}
      `).all(key, ...docArgs);
      if (rows.length && rows[0].dims !== query32.length) {
        throw new LearningError('invalid', `${key} vectors have ${rows[0].dims} dimensions, the query has ${query32.length}`);
      }
      rankings.push(rows
        .map((row) => ({ id: row.chunk_id, score: cosine(query32, blobToVector(row.vector)) }))
        .filter((ranked) => ranked.score > 0)
        .sort((a, b) => b.score - a.score || a.id - b.id)
        .slice(0, pool)
        .map((ranked) => ranked.id));
    }
    semantic = rankings.flat();
    const mode = queries.length ? 'hybrid' : keywordMode;
    if (!keyword.length && !semantic.length) return { mode, results: [] };
    const fused = !queries.length ? keyword.map((chunkId, i) => ({ id: chunkId, score: 1 / (60 + i + 1) }))
      : fuseRanks([keyword, ...rankings]);
    const get = this.db.prepare(`
      SELECT c.*, d.title AS document_title, d.chunk_count FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
      WHERE c.id = ?
    `);
    const results = fused.slice(0, page).map(({ id: chunkId, score }) => {
      const hit = chunkHit(get.get(chunkId));
      return { ...citationOf(hit), score: Number(score.toFixed(6)) };
    });
    return { mode, results };
  }
}

/** The document kinds the knowledge base takes; the table's CHECK holds the same list. */
export const DOCUMENT_KINDS = ['txt', 'md', 'pdf'];

const documentRow = (row) => row && ({
  id: row.id, title: row.title, kind: row.kind, sourceName: row.source_name, chars: row.chars,
  chunkCount: row.chunk_count, language: row.language, embeddingStatus: row.embedding_status,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

const chunkHit = (row) => row && ({
  chunkId: row.id, documentId: row.document_id, documentTitle: row.document_title, chunkCount: row.chunk_count,
  ordinal: row.ordinal, start: row.start, end: row.end, heading: row.heading, text: row.text,
});

function modelName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > LIMITS.model) {
    throw new LearningError('invalid', `model must be a non-empty string of at most ${LIMITS.model} characters`);
  }
  return value.trim();
}

/** The modes a session can be in; the table's CHECK holds the same list. */
export const SESSION_MODES = ['qa', 'socratic', 'quiz'];

function sessionKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new LearningError('invalid', 'sessionId must be a non-empty string of at most 200 characters');
  }
  return value.trim();
}
