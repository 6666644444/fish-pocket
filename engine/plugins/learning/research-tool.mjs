// Deep Research's wiring (M5): the `deep_research` tool the model calls, the background job
// a run lives in, and the model, web and knowledge-base adapters research.mjs is given.
//
// The model: the one the calling session last routed (session.requestHeader().config, the
// way dsh-compaction-basic finds it), through ctx.llm, so credentials and the Fish Pocket
// route work as in the session. The web: ctx.web (search provider and fetch the user set
// up in DSH). The knowledge base: the learning library (M3), with Apple vectors when present.
//
// A run is a dsh-jobs job owned by the session: the session sees its progress and is told
// when it ends. Each step is stored as it finishes, so a run the engine dropped (restart,
// the app killed) is resumed with `deep_research` action `resume`, from where it stopped.
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runResearch, TERMINAL, topicSimilarity } from './research.mjs';
import { appleQueryVectors } from './embed.mjs';
import { LearningError } from './store.mjs';
import { plain } from './wire.mjs';
import { fetchLegacy, htmlTitle, htmlToText, legacyCharset, metaCharset, refusedCharset } from './webtext.mjs';

export const TOOL = 'deep_research';

/** Text of a model reply; throws on an error, a cut-off, or an abort. */
export async function callModel(llm, target, { system, user, maxTokens }, signal) {
  const assembler = new BlockAssembler();
  const options = {
    provider: target.provider,
    model: target.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens,
    ...(signal ? { signal } : {}),
  };
  for await (const chunk of llm.stream(options)) assembler.push(chunk);
  const finish = assembler.finish;
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    throw new Error(finish.failure?.message ?? `the model request ended: ${finish.kind}`);
  }
  return assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join('');
}

/** The provider and model a session's agent uses, or undefined. */
export function sessionTarget(agent) {
  const header = agent?.session?.requestHeader?.()?.config;
  if (header?.provider && header?.model) return { provider: header.provider, model: header.model };
  const options = agent?.options;
  if (options?.provider && options?.model) return { provider: options.provider, model: options.model };
  return undefined;
}

/**
 * One page as research reads it: DSH's fetch, then, for a page in a Chinese legacy charset
 * DSH refused or read as UTF-8, a second read decoded properly (webtext.mjs).
 */
export async function fetchPage(web, url, signal, { fetchImpl } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) pages can be read');
  let result;
  try {
    result = await web.fetch({ url }, signal);
  } catch (error) {
    const charset = refusedCharset(error);
    const again = charset ? await fetchLegacy(url, charset, { signal, ...(fetchImpl ? { fetchImpl } : {}) }) : null;
    if (!again) throw error;
    return page(again.url, again.content, again.html);
  }
  const body = String(result?.body?.content ?? '');
  const html = result?.body?.kind !== 'text';
  const named = html ? legacyCharset(metaCharset(body)) : undefined;
  // Named only in <meta>: DSH decoded it as UTF-8, so the Chinese came out as U+FFFD.
  if (named && (body.match(/\uFFFD/g)?.length ?? 0) > 20) {
    const again = await fetchLegacy(result?.url ?? url, named, { signal, ...(fetchImpl ? { fetchImpl } : {}) }).catch(() => null);
    if (again) return page(again.url, again.content, again.html);
  }
  return page(result?.url ?? url, body, html);
}

function page(url, content, html) {
  const text = html ? htmlToText(content) : String(content).replace(/\s+/g, ' ').trim();
  return { url, title: (html && htmlTitle(content)) || url, text: text.slice(0, 20_000) };
}

/** The research sources for a job: web through ctx.web, the knowledge base through the library. */
export function researchTools({ web, store, embedder, sources, signal, fetchImpl }) {
  const tools = {};
  if (sources.includes('web') && web) {
    tools.search = async (query) => {
      const result = await web.search({ query, maxResults: 5 }, signal);
      return { results: (result?.sources ?? []).map((s) => ({ title: s.title ?? s.url, url: s.url, snippet: s.snippet ?? s.summary ?? '' })) };
    };
    tools.fetch = (url) => fetchPage(web, url, signal, { fetchImpl });
  }
  if (sources.includes('kb') && store.listDocuments().length) {
    tools.kb = async (query) => {
      let queryVectors;
      if (embedder && store.getSettings().appleEmbedding) {
        try { queryVectors = await appleQueryVectors(store, embedder, query); } catch { queryVectors = undefined; }
      }
      return store.searchKnowledge({ query: query.slice(0, 200), queryVectors: queryVectors?.length ? queryVectors : undefined, limit: 5 });
    };
  }
  return tools;
}

/**
 * How a research run ends, as dsh-jobs takes it (`JobOutcome`: `status` 'completed' |
 * 'killed' | 'failed', optional `detail`). An outcome of any other shape leaves the job
 * neither running nor finished: it shows as running for ever, cannot be stopped, and its
 * completion notice reads "[status: undefined]" — what happened with `{ kind }` before.
 */
export function jobOutcome(final) {
  if (final.status === 'done') return { status: 'completed', detail: 'report ready' };
  if (final.status === 'cancelled') return { status: 'killed', detail: 'cancelled' };
  if (final.status === 'paused') return { status: 'killed', detail: 'paused before it finished' };
  return { status: 'failed', detail: String(final.error ?? final.status ?? 'failed').slice(0, 300) };
}

/** The job's last line, which the completion notice shows the model. */
export function finalLine(jobId, final) {
  if (final.status === 'done') return `Research #${jobId} finished. Read the report with ${TOOL} action "report", id ${jobId}.\n`;
  if (final.status === 'paused') {
    return `Research #${jobId} was stopped before it finished and is paused. Do not resume it on your own: `
      + 'tell the user, who can continue it if they want.\n';
  }
  return `Research #${jobId} ended ${final.status}${final.error ? `: ${final.error}` : ''}. Do not start it again on your own.\n`;
}

/**
 * Whether a turn's new messages are only background-job notices (dsh-tool-jobs wakes an idle
 * conversation with one when a job ends). Such a turn was not asked for by anyone, so it may
 * not start or resume research: one research ending must never set off the next.
 */
export function backgroundOnly(messages) {
  const own = (messages ?? []).filter((m) => m?.role === 'user');
  return own.length > 0 && own.every((m) => m.source?.kind === 'tool-jobs');
}

/**
 * Runs research jobs: at most one run per job at a time, each inside a dsh-jobs job when
 * the composition has them (else in the background of the engine).
 */
export class ResearchRunner {
  /** @param {{ open:()=>object, get:(name:string)=>any, embedder?:object|null, logger?:object, callModel?:Function }} deps */
  constructor({ open, get, embedder = null, logger, callModel: call = callModel }) {
    this.open = open;
    this.get = get;
    this.embedder = embedder;
    this.logger = logger;
    this.call = call;
    this.running = new Map();
    /** What groups Sessions for "one at a time": the plugin sets it to the Bot or group (dsbot.mjs). */
    this.keyOf = (sessionId) => sessionId;
    this.stopped = new AbortController();
  }

  /**
   * The job running for `sessionId`'s owner, if any: a conversation, a Bot (all its parts)
   * or a group (all its members) runs one research at a time.
   */
  runningIn(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return undefined;
    const key = this.keyOf(sessionId);
    for (const [jobId, entry] of this.running) if (entry.sessionId && this.keyOf(entry.sessionId) === key) return jobId;
    return undefined;
  }

  /** Start or resume job `jobId` for a session's agent; returns at once. */
  start(jobId, { agent, toolCall } = {}) {
    if (this.running.has(jobId)) return { started: false, reason: 'already running' };
    const store = this.open();
    const job = store.getResearchJob({ id: jobId, withReport: false });
    if (TERMINAL.includes(job.status)) return { started: false, reason: job.status };
    const owner = agent?.session?.id ?? job.sessionId ?? undefined;
    const other = this.runningIn(owner);
    if (other !== undefined) return { started: false, reason: `research #${other} is already running in this conversation; one runs at a time` };
    const target = sessionTarget(agent) ?? job.target ?? undefined;
    const llm = this.get('llm');
    if (!llm || !target) throw new LearningError('unavailable', `${TOOL}: no model is available for research in this session`);
    if (!job.target || job.target.provider !== target.provider || job.target.model !== target.model) store.setResearchTarget({ id: jobId, target });
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.stopped.signal]);
    const run = (progress) => runResearch(store, jobId, {
      llm: (prompt) => this.call(llm, target, prompt, signal),
      tools: researchTools({ web: this.get('web'), store, embedder: this.embedder, sources: job.sources, signal }),
      signal,
      onProgress: progress,
    });
    const jobs = this.get('jobs');
    let done;
    if (jobs && owner) {
      try {
        jobs.start({
          kind: 'research',
          label: `deep research #${jobId}: ${job.topic.slice(0, 80)}`,
          owner,
          ...(toolCall ? { toolCall } : {}),
          outputLimitBytes: 4_000,
          run: (handle) => {
            done = run((line) => { handle.updateProgress(line); }).then((final) => {
              handle.append(finalLine(jobId, final));
              return jobOutcome(final);
            }, (error) => ({ status: 'failed', detail: String(error?.message ?? error).slice(0, 300) }));
            return { cancel: () => controller.abort(), done };
          },
        });
      } catch (error) {
        // The owner session has no live agent (resumed from the app): run without a job.
        this.logger?.warn?.(`learning: research #${jobId} runs without a job: ${error?.message ?? error}`);
      }
    }
    done ??= run(() => {});
    const settled = Promise.resolve(done).catch((error) => this.logger?.warn?.(`learning: research #${jobId}: ${error?.message ?? error}`))
      .finally(() => this.running.delete(jobId));
    this.running.set(jobId, { controller, settled, sessionId: typeof owner === 'string' ? owner : undefined });
    return { started: true };
  }

  /** Mark a job cancelled: a running one stops after the step in progress (PLAN §10). */
  cancel(jobId) {
    return this.open().cancelResearch({ id: jobId });
  }

  /** Abort every run (plugin disposal); jobs stay `paused` in the library. */
  async dispose() {
    this.stopped.abort();
    await Promise.all([...this.running.values()].map((entry) => entry.settled));
  }
}

const DESCRIPTION = 'Deep research: plans the question, researches each part with several rounds of web search '
  + '(and the learner\'s knowledge base), cross-checks the key claims against independent sources, looks for gaps and '
  + 'researches them, then writes a report with numbered sources. It runs in the background for several minutes. '
  + 'Use it when the user asks for research, a deep dive or a sourced report, not for a quick fact. '
  + '`start` with a clear topic (clarify the scope with the user first if it is vague) returns a job id at once; you are told when it ends. '
  + '`status` shows progress, `report` returns the finished report (show it to the user as it is, with its sources), '
  + '`resume` continues a paused job, only when the user asks for it; `cancel` stops one, `list` shows recent jobs. '
  + 'Never start or resume research because a background job ended: tell the user and let them decide.';

/**
 * @param {() => object} open
 * @param {ResearchRunner} runner
 * @param {{ backgroundTurn?: (sessionId: string) => boolean }} [options] - whether the session's
 *   current turn was opened by a background-job notice alone (index.mjs records it per turn).
 */
export function researchTool(open, runner, { backgroundTurn = () => false } = {}) {
  return defineTool({
    name: TOOL,
    description: DESCRIPTION,
    parameters: {
      action: { type: 'string', enum: ['start', 'status', 'report', 'resume', 'cancel', 'list'], required: true, description: 'what to do' },
      topic: { type: 'string', description: 'start: the research question, specific and self-contained' },
      depth: { type: 'string', enum: ['quick', 'standard', 'deep'], description: 'start: quick (2 parts), standard (4, default) or deep (6)' },
      sources: { type: 'array', items: { type: 'string', enum: ['web', 'kb'] }, description: 'start: web and/or kb (the learner\'s knowledge base); default both' },
      id: { type: 'number', description: 'the job id, for every action except start and list' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => [{ type: 'text', text: render(args.action, value) }],
    },
    // Every result as lossless JSON (wire.mjs): one undefined field fails the whole call.
    execute: async (args, exec) => plain(await (async () => {
      const store = open();
      const agent = exec?.agent;
      if (args.action === 'list') return { jobs: store.listResearchJobs({ limit: 10 }) };
      // A turn no one asked for (a job's completion notice) never spends on research.
      if ((args.action === 'start' || args.action === 'resume') && backgroundTurn(agent?.session?.id)) {
        const reason = 'not started: this turn was opened by a background job ending, not by the user. Tell the user what happened; research starts or continues only when they ask';
        const known = Number.isInteger(args.id) ? (() => { try { return store.getResearchJob({ id: args.id, withReport: false }); } catch { return undefined; } })() : undefined;
        return known ? { started: false, reason, job: known } : { started: false, reason, refused: true };
      }
      if (args.action === 'start') {
        const sessionId = agent?.session?.id;
        // One research at a time in a conversation: a second start reports the running one.
        const running = runner.runningIn(sessionId);
        if (running !== undefined) {
          return { started: false, reason: `research #${running} is already running in this conversation; wait for it or cancel it first`, job: store.getResearchJob({ id: running, withReport: false }) };
        }
        // A paused job on the same question in this conversation is resumed, not started over.
        const topic = String(args.topic ?? '');
        const paused = typeof sessionId === 'string' && topic.trim()
          ? store.listResearchJobs({ limit: 50 }).find((j) => j.sessionId && runner.keyOf(j.sessionId) === runner.keyOf(sessionId) && (j.status === 'paused' || j.status === 'planned') && topicSimilarity(j.topic, topic) >= 0.6)
          : undefined;
        if (paused) return { ...runner.start(paused.id, { agent, toolCall: exec?.toolCall }), resumed: true, job: store.getResearchJob({ id: paused.id, withReport: false }) };
        const allowWeb = store.getSettings().researchWeb !== false;
        let sources = Array.isArray(args.sources) && args.sources.length ? args.sources : ['web', 'kb'];
        if (!allowWeb) sources = sources.filter((s) => s !== 'web');
        if (!sources.length) throw new Error(`${TOOL}: web search for research is turned off in Settings → Learning, and no other source was chosen`);
        const job = store.createResearchJob({ topic: args.topic ?? '', depth: args.depth ?? 'standard', sources, sessionId: typeof sessionId === 'string' ? sessionId : undefined });
        return { ...runner.start(job.id, { agent, toolCall: exec?.toolCall }), job };
      }
      if (!Number.isInteger(args.id)) throw new Error(`${TOOL}: ${args.action} needs the job id`);
      if (args.action === 'resume') return { ...runner.start(args.id, { agent }), job: store.getResearchJob({ id: args.id, withReport: false }) };
      if (args.action === 'cancel') return { job: runner.cancel(args.id) };
      const job = store.getResearchJob({ id: args.id, withReport: args.action === 'report' });
      return { job };
    })()),
  });
}

function render(action, value) {
  if (action === 'list') {
    if (!value.jobs.length) return 'No research jobs yet.';
    return value.jobs.map((j) => `#${j.id} ${j.status} (${j.blocksDone}/${j.blocks} parts, ${j.citations} sources): ${j.topic}`).join('\n');
  }
  if (value.refused) return `Not started: ${value.reason}.`;
  const j = value.job;
  if (action === 'report' && j.status === 'done') return j.report ?? '(no report)';
  const head = `Research #${j.id} — ${j.status}${j.phase && j.phase !== j.status ? `, ${j.phase}` : ''}${j.progress ? ` (${j.progress})` : ''}`;
  const extra = value.started === false && value.reason ? ` Not started: ${value.reason}.` : value.started ? ' Running in the background; you will be told when it ends.' : '';
  const resumed = value.resumed ? ` This continues paused research #${j.id} on the same question (finished parts are kept) instead of starting a new one.` : '';
  const err = j.error ? ` Error: ${j.error}` : '';
  return `${head}: ${j.blocksDone}/${j.blocks} parts researched, ${j.citations} sources, ${j.callsUsed} model calls.${extra}${resumed}${err}`;
}
