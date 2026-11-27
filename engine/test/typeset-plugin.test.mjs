// extras/firefly-typeset (D52): the layout section it adds to the system prompt, and its package
// as the plugin manager reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, guide, forReader, inject, ORDER, RULES_LIMIT } from '../../extras/firefly-typeset/index.js';

const dir = fileURLToPath(new URL('../../extras/firefly-typeset/', import.meta.url));

/** A Cordis context with just what the plugin touches. */
function fakeCtx() {
  const sections = [];
  const disposed = [];
  return {
    sections,
    disposed,
    effect(fn, label) {
      const dispose = fn();
      assert.equal(typeof dispose, 'function', 'section() returns its disposer');
      assert.match(label, /firefly-typeset/);
      disposed.push(dispose);
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => { sections.splice(sections.indexOf(section), 1); };
      },
    },
  };
}

test('one section, after deliverable guidance and before structured output, not interpolated', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  assert.deepEqual(inject, ['systemPrompt']);
  assert.equal(ctx.sections.length, 1);
  const [section] = ctx.sections;
  assert.equal(section.name, 'firefly-typeset');
  assert.equal(section.order, ORDER);
  assert.ok(ORDER > 9000 && ORDER < 9900);
  assert.equal(section.interpolate, false, '$…$ and {…} are not prompt variables');
  ctx.disposed[0]();
  assert.equal(ctx.sections.length, 0, 'unloading removes it');
});

test('the reader gets the guide, the same text every time; a subagent gets nothing', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const { text } = ctx.sections[0];
  const main = { session: { header: { origin: 'user' } } };
  const sub = { session: { header: { origin: 'subagent' } } };
  const first = text({ agent: main });
  assert.ok(first.length > 0);
  assert.equal(text({ agent: main }), first, 'static: the cached prefix keeps it');
  assert.equal(text({}), first, 'an assembly without an agent gets it too');
  assert.equal(text(undefined), first);
  assert.equal(text({ agent: sub }), '');
  assert.equal(forReader(sub), false);
  assert.equal(forReader(main), true);
});

test('the guide covers formulas, steps, callouts and pictures, and stays small', () => {
  const text = guide();
  for (const needle of ['$$', '\\boxed{…}', '\\underbrace', '### 第一步', '[!NOTE]', '[!TIP]', '[!IMPORTANT]', '[!WARNING]', '[!CAUTION]', '[!NOTE]- 证明', 'show_view']) {
    assert.ok(text.includes(needle), needle);
  }
  assert.ok(text.includes('\\\\'), 'a LaTeX line break is written as two backslashes');
  assert.ok(text.length < 2400, `${text.length} characters`);
  assert.doesNotMatch(text, /\{\{/, 'nothing that reads as a prompt variable');
});

test('callouts: false asks for bold-label quotes instead', () => {
  const text = guide({ callouts: false });
  assert.doesNotMatch(text, /\[!/);
  assert.match(text, /> \*\*重点\*\*/);
});

test('the user\'s own rules come last, capped', () => {
  const text = guide({ rules: '  答案用红色标出  ' });
  assert.ok(text.endsWith('答案用红色标出'));
  assert.match(text, /win over the above/);
  const long = guide({ rules: 'x'.repeat(RULES_LIMIT + 500) });
  assert.ok(long.endsWith('x'.repeat(RULES_LIMIT)));
  assert.ok(!long.endsWith('x'.repeat(RULES_LIMIT + 1)));
  assert.equal(guide({ rules: '   ' }), guide(), 'blank rules add nothing');
  assert.equal(guide({ rules: 42 }), guide(), 'rules that are not text are ignored');
});

test('enabled: false registers nothing', () => {
  const ctx = fakeCtx();
  apply(ctx, { enabled: false });
  assert.equal(ctx.sections.length, 0);
});

test('the package: manifest, patch, locales and icon as the plugin manager reads them', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client, undefined, 'Host only: no browser half');
  for (const file of pkg.files) {
    if (file.includes('*')) continue;
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} is there`);
  }
  assert.equal(pkg.exports['.'], './index.js');
  const patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, new RegExp(`name: ${pkg.name}\\n`), 'the patch mounts this package');
  for (const lang of ['en', 'zh', 'ja', 'es']) {
    const locale = JSON.parse(fs.readFileSync(path.join(dir, 'locale', `${lang}.json`), 'utf8'));
    assert.ok(locale.meta.title && locale.meta.description, lang);
  }
  const icon = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  assert.match(icon, /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(Buffer.byteLength(icon) < 256 * 1024);
  assert.ok(Object.keys(pkg.dependencies ?? {}).length === 0, 'nothing to install');
});
