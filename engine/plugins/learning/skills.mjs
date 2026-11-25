// The user's own skills, kept where DSH already looks for them: `$DSH_HOME/skills`, the
// `user-dsh` root of @deepseek-ai/dsh-skill-filesystem. A skill is a folder `<name>/` with
// a `SKILL.md` whose YAML frontmatter has `name` and `description` (optionally `whenToUse`);
// DSH watches that root, so a skill added, edited or removed here reaches the next turn of
// every session without a restart. Nothing here is a second skill system.
//
// The folder is one level below `$DSH_HOME`, so the engine's recovery never takes these
// files for settings (runtime/recovery.mjs only looks at files directly in `$DSH_HOME` and
// `profiles/web`).
//
// What this module changes: only skills it wrote itself, marked in the frontmatter with
// `metadata: { created-by: dsh-learning }`. Skills that were already there (written by the
// agent, copied in by hand) are listed and can be read, but are never rewritten or
// deleted from here. Names starting with `learning-` are kept for the app's own modes.
import fs from 'node:fs';
import path from 'node:path';
import { isSkillName } from '@deepseek-ai/dsh-skill';
import { LearningError } from './store.mjs';

export const MARK_KEY = 'created-by';
export const MARK_VALUE = 'dsh-learning';
export const RESERVED_PREFIX = 'learning-';
/** `description` stops at 500 because dsh-tool-skill cuts catalog descriptions there. */
export const SKILL_LIMITS = { name: 64, description: 500, whenToUse: 1_024, body: 100_000 };

/** The `user-dsh` skill root under `$DSH_HOME`. */
export function skillsDir(home = process.env.DSH_HOME) {
  if (!home) throw new LearningError('unavailable', 'DSH_HOME is not set');
  return path.join(home, 'skills');
}

const codepoints = (value) => [...value].length;

/** A YAML scalar written back as YAML reads it. */
function scalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return value; }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

/**
 * Split a SKILL.md into its frontmatter and its body, the way dsh-skill-filesystem
 * delimits them (a first line `---`, then the next line that is exactly `---`).
 * Only what this module shows or checks is read from the frontmatter: top-level
 * scalars, `|`/`>` blocks, and whether `metadata` carries this module's mark.
 * DSH parses the full YAML itself; this is not a YAML parser.
 * @returns {{ meta: Record<string,string>, managed: boolean, body: string } | undefined}
 *   undefined when there is no frontmatter.
 */
export function parseSkill(text) {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines[0] !== '---') return undefined;
  const end = lines.indexOf('---', 1);
  if (end < 0) return undefined;
  const meta = {};
  let managed = false;
  let block;
  let inMetadata = false;
  for (const line of lines.slice(1, end)) {
    const top = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (top) {
      block = undefined;
      inMetadata = top[1] === 'metadata';
      const value = top[2].trim();
      if (/^[|>][+-]?$/.test(value)) {
        block = { key: top[1], folded: value.startsWith('>'), parts: [] };
        meta[top[1]] = '';
      } else if (!inMetadata) {
        meta[top[1]] = scalar(value);
      }
      continue;
    }
    if (block && (/^\s/.test(line) || line === '')) {
      block.parts.push(line.trim());
      meta[block.key] = block.parts.join(block.folded ? ' ' : '\n').trim();
      continue;
    }
    const nested = /^\s+([\w-]+):(.*)$/.exec(line);
    if (inMetadata && nested && nested[1] === MARK_KEY && scalar(nested[2]) === MARK_VALUE) managed = true;
  }
  return { meta, managed, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

/** The SKILL.md this module writes. Values are JSON strings, which YAML reads as double-quoted scalars. */
export function renderSkill({ name, description, whenToUse, body }) {
  const head = ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`];
  if (whenToUse) head.push(`whenToUse: ${JSON.stringify(whenToUse)}`);
  head.push('metadata:', `  ${MARK_KEY}: ${MARK_VALUE}`, '---', '');
  return `${head.join('\n')}\n${body.replace(/\s+$/, '')}\n`;
}

function field(value, key, max, { required = true, line = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new LearningError('invalid', `${key} is empty`);
    return undefined;
  }
  if (typeof value !== 'string') throw new LearningError('invalid', `${key} must be a string`);
  const trimmed = line ? value.replace(/\s+/g, ' ').trim() : value;
  if (required && !trimmed.trim()) throw new LearningError('invalid', `${key} is empty`);
  if (codepoints(trimmed) > max) throw new LearningError('invalid', `${key} is longer than ${max} characters`);
  return trimmed || undefined;
}

function checkName(name, { creating = false } = {}) {
  if (typeof name !== 'string' || !isSkillName(name) || codepoints(name) > SKILL_LIMITS.name) {
    throw new LearningError('invalid', 'name must be kebab-case: lowercase letters, digits and single hyphens');
  }
  if (creating && name.startsWith(RESERVED_PREFIX)) {
    throw new LearningError('invalid', `names starting with "${RESERVED_PREFIX}" are kept for the app's learning modes`);
  }
  return name;
}

/** Write `text` to `file` whole: a temporary file beside it, then a rename. */
function writeWhole(file, text) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export class SkillFiles {
  /** @param {string} dir - the skill root (`skillsDir()`); tests use a temporary folder. */
  constructor(dir) {
    this.dir = dir;
  }

  /** Where `name` lives now: a folder bundle, a flat `<name>.md`, or nowhere. */
  #locate(name) {
    const bundle = path.join(this.dir, name, 'SKILL.md');
    if (fs.existsSync(bundle)) return { kind: 'bundle', file: bundle };
    const flat = path.join(this.dir, `${name}.md`);
    if (fs.existsSync(flat)) return { kind: 'file', file: flat };
    if (fs.existsSync(path.join(this.dir, name))) return { kind: 'other', file: path.join(this.dir, name) };
    return undefined;
  }

  #summary(name, kind, file) {
    let parsed;
    try { parsed = parseSkill(fs.readFileSync(file, 'utf8')); } catch { parsed = undefined; }
    const meta = parsed?.meta ?? {};
    return {
      name,
      kind,
      description: typeof meta.description === 'string' ? meta.description : '',
      whenToUse: typeof meta.whenToUse === 'string' && meta.whenToUse ? meta.whenToUse : undefined,
      managed: kind === 'bundle' && parsed?.managed === true,
      // What DSH itself needs to take the file: frontmatter with a valid name and a description.
      valid: Boolean(parsed && typeof meta.name === 'string' && isSkillName(meta.name) && meta.description),
    };
  }

  /** Every skill in the root, by name. */
  list() {
    let entries;
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const found = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        const file = path.join(this.dir, entry.name, 'SKILL.md');
        if (fs.existsSync(file)) found.push(this.#summary(entry.name, 'bundle', file));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        found.push(this.#summary(entry.name.slice(0, -3), 'file', path.join(this.dir, entry.name)));
      }
    }
    return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  get({ name }) {
    checkName(name);
    const at = this.#locate(name);
    if (!at || at.kind === 'other') throw new LearningError('not-found', `no skill ${name}`);
    const text = fs.readFileSync(at.file, 'utf8');
    return { ...this.#summary(name, at.kind, at.file), body: parseSkill(text)?.body ?? text };
  }

  create({ name, description, whenToUse, body }) {
    checkName(name, { creating: true });
    const skill = {
      name,
      description: field(description, 'description', SKILL_LIMITS.description, { line: true }),
      whenToUse: field(whenToUse, 'whenToUse', SKILL_LIMITS.whenToUse, { required: false, line: true }),
      body: field(body, 'body', SKILL_LIMITS.body),
    };
    if (this.#locate(name)) throw new LearningError('conflict', `a skill or file named ${name} already exists`);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const folder = path.join(this.dir, name);
    fs.mkdirSync(folder, { mode: 0o700 });
    writeWhole(path.join(folder, 'SKILL.md'), renderSkill(skill));
    return this.get({ name });
  }

  #mine(name) {
    checkName(name);
    const at = this.#locate(name);
    if (!at || at.kind === 'other') throw new LearningError('not-found', `no skill ${name}`);
    if (!this.#summary(name, at.kind, at.file).managed) {
      throw new LearningError('conflict', `${name} was not created in Learning, so it is not changed from here`);
    }
    return at;
  }

  /** Rewrite a skill this module created. Fields left out keep their value. */
  update({ name, description, whenToUse, body }) {
    const at = this.#mine(name);
    const current = this.get({ name });
    const skill = {
      name,
      description: description === undefined ? current.description
        : field(description, 'description', SKILL_LIMITS.description, { line: true }),
      whenToUse: whenToUse === undefined ? current.whenToUse
        : field(whenToUse, 'whenToUse', SKILL_LIMITS.whenToUse, { required: false, line: true }),
      body: body === undefined ? current.body : field(body, 'body', SKILL_LIMITS.body),
    };
    writeWhole(at.file, renderSkill(skill));
    return this.get({ name });
  }

  /** Delete a skill this module created: its SKILL.md and then its (now empty) folder. */
  delete({ name }) {
    const at = this.#mine(name);
    const folder = path.dirname(at.file);
    const others = fs.readdirSync(folder).filter((entry) => entry !== 'SKILL.md');
    if (others.length) throw new LearningError('conflict', `${name} holds other files (${others.join(', ')}), so it is left as it is`);
    fs.rmSync(at.file);
    fs.rmdirSync(folder);
    return { deleted: true };
  }
}
