/**
 * Firefly 排版 (firefly-typeset): one fixed section of the system prompt on how replies are laid
 * out, so they read well on a phone: display formulas, boxed answers, short headed steps and
 * callouts (`> [!TIP] 技巧`). The Firefly app draws the callouts in colour (D52); a client that
 * does not shows them as quotes.
 *
 * The text is the same for every request, so the cached prefix holds it after the first one;
 * a change of config changes it once. Subagents get nothing: what they write goes to their
 * parent, not to the reader.
 */

/** Where the section sits: after the deliverable-file guidance (9000), before a structured-output requirement (9900). */
export const ORDER = 9500
/** A user's own rules are cut here, so a long paste cannot blow up every request. */
export const RULES_LIMIT = 1000

export const inject = ['systemPrompt']

const HEAD = [
  '# Answer layout',
  'Lay out the replies you write for the user so they read well on a phone. This does not apply to code, files, '
    + 'tool arguments or a one-line answer, nor when the user or another instruction asks for a particular format.',
  '',
  '- Mathematics: inline math as $…$. Put any formula worth reading by itself on lines of its own as $$ … $$, one '
    + 'step of a derivation per line (an aligned environment with \\\\ for a chain of equalities). Box the final '
    + 'answer: \\boxed{…}. Name a part of an expression with \\underbrace{…}_{\\text{…}}.',
  '- A worked solution: short steps, each with a small heading (### 第一步：配方) and its formula on its own line, '
    + 'rather than one long paragraph. End with the answer, boxed.',
]

const CALLOUTS = [
  '- Callouts single out a few points, not every paragraph. Each is a quote whose first line is a marker, '
    + 'optionally followed by a short title in the user\'s language:',
  '  > [!IMPORTANT] 重点',
  '  > 平方项永远非负',
  '  Markers: [!NOTE] (definition, background), [!TIP] (method, shortcut), [!IMPORTANT] (key point, conclusion), '
    + '[!WARNING] (common mistake, trap), [!CAUTION] (serious error). Put "-" right after the marker '
    + '([!NOTE]- 证明) for a long aside the reader can unfold. Formulas and lists work inside a callout.',
]

const PLAIN_CALLOUTS = [
  '- Single out a few points (a key point, a method, a common mistake) as a quote that starts with a bold label: '
    + '> **重点**：平方项永远非负',
]

const TAIL = [
  '- Tables for comparisons. No HTML, no decorative emoji, no rule between every section.',
  '- For a function, a geometric figure or data, a picture helps: if you have the show_view tool, draw it there; '
    + 'otherwise name what matters in it (vertex, intercepts, monotonic intervals).',
]

/**
 * The section's text for a config.
 * @param {{ callouts?: boolean, rules?: string }} [config]
 *   `callouts: false` asks for bold-label quotes instead, for clients that draw no callouts;
 *   `rules` are the user's own, added at the end.
 */
export function guide(config = {}) {
  const lines = [...HEAD, ...(config.callouts === false ? PLAIN_CALLOUTS : CALLOUTS), ...TAIL]
  const rules = typeof config.rules === 'string' ? config.rules.trim().slice(0, RULES_LIMIT) : ''
  if (rules) lines.push('', 'The user\'s own layout rules, which win over the above:', rules)
  return lines.join('\n')
}

/** The reader sees what this agent writes: not a subagent's, which goes to its parent. */
export function forReader(agent) {
  return agent?.session?.header?.origin !== 'subagent'
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const text = guide(config)
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'firefly-typeset',
    order: ORDER,
    // $…$ and {…} are the model's, not prompt variables.
    interpolate: false,
    text: (context) => (forReader(context?.agent) ? text : ''),
  }), 'firefly-typeset: layout section')
}
