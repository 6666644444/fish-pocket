import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import Learning, { ROUTE } from '../plugins/learning/index.mjs';
import { MARK_KEY, MARK_VALUE, SKILL_LIMITS, SkillFiles, parseSkill, renderSkill, skillsDir } from '../plugins/learning/skills.mjs';

const root = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-skills-')), 'skills');

/** The frontmatter of a SKILL.md as YAML reads it (what DSH's skill-filesystem does). */
function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  assert.equal(lines[0], '---');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0);
  return { data: parseYaml(lines.slice(1, end).join('\n')), body: lines.slice(end + 1).join('\n') };
}

const sample = { name: 'exam-review', description: 'Review a chapter before an exam', body: '# Exam review\n\nAsk me three questions.' };

test('the skill root is $DSH_HOME/skills, the root DSH scans for the user', () => {
  assert.equal(skillsDir('/home/dsh/.dsh'), path.join('/home/dsh/.dsh', 'skills'));
  assert.throws(() => skillsDir(''), { kind: 'unavailable' });
});

test('no skill folder yet: an empty list, and nothing is created by looking', () => {
  const dir = root();
  assert.deepEqual(new SkillFiles(dir).list(), []);
  assert.equal(fs.existsSync(dir), false);
});

test('a new skill is <name>/SKILL.md with frontmatter DSH reads, marked as created here', () => {
  const dir = root();
  const skills = new SkillFiles(dir);
  const created = skills.create({ ...sample, whenToUse: 'Before a test' });
  assert.deepEqual(
    { name: created.name, kind: created.kind, managed: created.managed, valid: created.valid, whenToUse: created.whenToUse },
    { name: 'exam-review', kind: 'bundle', managed: true, valid: true, whenToUse: 'Before a test' },
  );
  const file = path.join(dir, 'exam-review', 'SKILL.md');
  const { data, body } = frontmatter(file);
  assert.deepEqual(data, {
    name: 'exam-review', description: 'Review a chapter before an exam', whenToUse: 'Before a test', metadata: { [MARK_KEY]: MARK_VALUE },
  });
  assert.equal(body.trim(), sample.body);
  assert.equal(created.body.trim(), sample.body);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'exam-review')), ['SKILL.md']);
  assert.deepEqual(skills.list().map((s) => s.name), ['exam-review']);
});

test('awkward descriptions survive YAML: quotes, colons, #, backslashes, emoji, CJK; newlines fold', () => {
  const dir = root();
  const skills = new SkillFiles(dir);
  const description = 'Say "hi": #1 \\ path C:\\x — 复习 🙂 \'quoted\'';
  skills.create({ name: 'awkward', description: `${description}\n second line`, body: 'x' });
  const { data } = frontmatter(path.join(dir, 'awkward', 'SKILL.md'));
  assert.equal(data.description, `${description} second line`);
  assert.equal(skills.get({ name: 'awkward' }).description, `${description} second line`);
});

test('bad input is refused before anything is written', () => {
  const dir = root();
  const skills = new SkillFiles(dir);
  for (const name of ['Bad Name', 'UPPER', 'a--b', '-a', 'a-', '', 'x'.repeat(65), 'learning-mine', 42]) {
    assert.throws(() => skills.create({ ...sample, name }), { kind: 'invalid' }, String(name));
  }
  assert.throws(() => skills.create({ ...sample, description: '  ' }), { kind: 'invalid' });
  assert.throws(() => skills.create({ ...sample, description: 'x'.repeat(SKILL_LIMITS.description + 1) }), { kind: 'invalid' });
  assert.throws(() => skills.create({ ...sample, body: '' }), { kind: 'invalid' });
  assert.throws(() => skills.create({ ...sample, body: 'x'.repeat(SKILL_LIMITS.body + 1) }), { kind: 'invalid' });
  assert.equal(fs.existsSync(dir), false);
});

test('a name already taken by a folder or a flat .md is a conflict', () => {
  const dir = root();
  fs.mkdirSync(path.join(dir, 'taken-dir'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'flat.md'), '---\nname: flat\ndescription: d\n---\nbody\n');
  const skills = new SkillFiles(dir);
  assert.throws(() => skills.create({ ...sample, name: 'taken-dir' }), { kind: 'conflict' });
  assert.throws(() => skills.create({ ...sample, name: 'flat' }), { kind: 'conflict' });
});

test("skills that were already there are listed and readable, but never changed or deleted from here", () => {
  const dir = root();
  const theirs = '---\nname: agent-made\ndescription: >\n  Written by\n  the agent\n---\n\nBody of theirs.\n';
  fs.mkdirSync(path.join(dir, 'agent-made'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-made', 'SKILL.md'), theirs);
  fs.writeFileSync(path.join(dir, 'flat.md'), '---\r\nname: flat\r\ndescription: "A flat one"\r\n---\r\nFlat body\r\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a skill');
  fs.mkdirSync(path.join(dir, '.hidden'));
  const skills = new SkillFiles(dir);
  assert.deepEqual(skills.list().map(({ name, kind, managed, valid, description }) => ({ name, kind, managed, valid, description })), [
    { name: 'agent-made', kind: 'bundle', managed: false, valid: true, description: 'Written by the agent' },
    { name: 'flat', kind: 'file', managed: false, valid: true, description: 'A flat one' },
  ]);
  assert.equal(skills.get({ name: 'agent-made' }).body.trim(), 'Body of theirs.');
  assert.equal(skills.get({ name: 'flat' }).body.trim(), 'Flat body');
  assert.throws(() => skills.update({ name: 'agent-made', body: 'mine now' }), { kind: 'conflict' });
  assert.throws(() => skills.delete({ name: 'agent-made' }), { kind: 'conflict' });
  assert.throws(() => skills.delete({ name: 'flat' }), { kind: 'conflict' });
  assert.equal(fs.readFileSync(path.join(dir, 'agent-made', 'SKILL.md'), 'utf8'), theirs);
  assert.throws(() => skills.get({ name: 'missing' }), { kind: 'not-found' });
});

test('a skill with no usable frontmatter is listed as invalid, the way DSH would skip it', () => {
  const dir = root();
  fs.mkdirSync(path.join(dir, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken', 'SKILL.md'), 'no frontmatter here');
  const [broken] = new SkillFiles(dir).list();
  assert.deepEqual({ name: broken.name, valid: broken.valid, managed: broken.managed }, { name: 'broken', valid: false, managed: false });
});

test('update rewrites the fields given and keeps the rest; an empty whenToUse clears it', () => {
  const dir = root();
  const skills = new SkillFiles(dir);
  skills.create({ ...sample, whenToUse: 'Before a test' });
  const updated = skills.update({ name: 'exam-review', body: 'New body' });
  assert.equal(updated.description, sample.description);
  assert.equal(updated.whenToUse, 'Before a test');
  assert.equal(updated.body.trim(), 'New body');
  const cleared = skills.update({ name: 'exam-review', whenToUse: '', description: 'Shorter' });
  assert.equal(cleared.whenToUse, undefined);
  assert.equal(cleared.description, 'Shorter');
  assert.equal(frontmatter(path.join(dir, 'exam-review', 'SKILL.md')).data.whenToUse, undefined);
  assert.equal(cleared.managed, true);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'exam-review')), ['SKILL.md']);
  assert.throws(() => skills.update({ name: 'exam-review', description: '' }), { kind: 'invalid' });
  assert.throws(() => skills.update({ name: 'missing', body: 'x' }), { kind: 'not-found' });
});

test('delete removes the skill and its folder, but leaves a folder that holds other files', () => {
  const dir = root();
  const skills = new SkillFiles(dir);
  skills.create(sample);
  assert.deepEqual(skills.delete({ name: 'exam-review' }), { deleted: true });
  assert.equal(fs.existsSync(path.join(dir, 'exam-review')), false);
  assert.deepEqual(skills.list(), []);
  skills.create(sample);
  fs.writeFileSync(path.join(dir, 'exam-review', 'extra.txt'), 'x');
  assert.throws(() => skills.delete({ name: 'exam-review' }), { kind: 'conflict' });
  assert.equal(fs.existsSync(path.join(dir, 'exam-review', 'SKILL.md')), true);
});

test('parseSkill: CRLF, block scalars, the mark only under metadata, no frontmatter', () => {
  const parsed = parseSkill('---\r\nname: a\r\ndescription: |\r\n  one\r\n  two\r\nmetadata:\r\n  created-by: dsh-learning\r\n---\r\nBody\r\n');
  assert.equal(parsed.meta.description, 'one\ntwo');
  assert.equal(parsed.managed, true);
  assert.equal(parsed.body.trim(), 'Body');
  assert.equal(parseSkill('---\nname: a\ndescription: d\ncreated-by: dsh-learning\n---\n').managed, false);
  assert.equal(parseSkill('# no frontmatter'), undefined);
  assert.equal(parseSkill('---\nname: a\n'), undefined);
  assert.match(renderSkill(sample), /^---\nname: exam-review\n/);
});

test('skill routes work without opening the learning library', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-learning-skill-routes-'));
  const file = path.join(base, 'learning', 'learning.db');
  const dir = path.join(base, 'skills');
  const routes = new Map();
  const ctx = {
    effect: (run) => run(),
    on: () => {},
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } },
  };
  new Learning(ctx, { file, skillsDir: dir });
  const post = async (method, body) => {
    const response = await routes.get(`${ROUTE}/${method}`).fetch(new Request(`http://x${ROUTE}/${method}`, { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await post('skills.create', sample)).status, 200);
  assert.equal((await post('skills.create', sample)).status, 409);
  assert.equal((await post('skills.create', { ...sample, name: 'Bad' })).status, 400);
  assert.deepEqual((await post('skills.list', {})).body.result.map((s) => s.name), ['exam-review']);
  assert.equal((await post('skills.get', { name: 'exam-review' })).body.result.body.trim(), sample.body);
  assert.equal((await post('skills.update', { name: 'exam-review', body: 'B' })).body.result.body.trim(), 'B');
  assert.equal((await post('skills.get', { name: 'nope' })).status, 404);
  assert.deepEqual((await post('skills.delete', { name: 'exam-review' })).body, { ok: true, result: { deleted: true } });
  assert.equal(fs.existsSync(path.dirname(file)), false);
});
