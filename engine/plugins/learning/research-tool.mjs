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
import { runResearch, TERMINAL } from './research.mjs';
import { appleQueryVectors } from './embed.mjs';
import { LearningError } from './store.mjs';

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

/** The research sources for a job: web through ctx.web, the knowledge base through the library. */
export function researchTools({ web, store, embedder, sources, signal }) {
  const tools = {};
  if (sources.includes('web') && web) {
    tools.search = async (query) => {
      const result = await web.search({ query, maxResults: 5 }, signal);
      return { results: (result?.sources ?? []).map((s) => ({ title: s.title ?? s.url, url: s.url, snippet: s.snippet ?? s.summary ?? '' })) };
    };
    tools.fetch = async (url) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) pages can be read');
      const result = await web.fetch({ url }, signal);
      const text = String(result?.body?.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return { url: result?.url ?? url, title: url, text: text.slice(0, 20_000) };
    };
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
    this.stopped = new AbortController();
  }

  /** Start or resume job `jobId` for a session's agent; returns at once. */
  start(jobId, { agent, toolCall } = {}) {
    if (this.running.has(jobId)) return { started: false, reason: 'already running' };
    const store = this.open();
    const job = store.getResearchJob({ id: jobId, withReport: false });
    if (TERMINAL.includes(job.status)) return { started: false, reason: job.status };
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
    const owner = agent?.session?.id ?? job.sessionId ?? undefined;
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
              handle.append(final.status === 'done'
                ? `Research #${jobId} finished. Read the report with ${TOOL} action "report", id ${jobId}.\n`
                : `Research #${jobId} ended ${final.status}${final.error ? `: ${final.error}` : ''}.\n`);
              return { kind: final.status === 'done' ? 'completed' : final.status === 'cancelled' ? 'killed' : 'failed', result: final.status };
            }, (error) => ({ kind: 'failed', detail: String(error?.message ?? error) }));
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
    this.running.set(jobId, { controller, settled });
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
  + '`resume` continues a paused job, `cancel` stops one, `list` shows recent jobs.';

export function researchTool(open, runner) {
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
    execute: async (args, exec) => {
      const store = open();
      const agent = exec?.agent;
      if (args.action === 'list') return { jobs: store.listResearchJobs({ limit: 10 }) };
      if (args.action === 'start') {
        const sessionId = agent?.session?.id;
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
    },
  });
}

function render(action, value) {
  if (action === 'list') {
    if (!value.jobs.length) return 'No research jobs yet.';
    return value.jobs.map((j) => `#${j.id} ${j.status} (${j.blocksDone}/${j.blocks} parts, ${j.citations} sources): ${j.topic}`).join('\n');
  }
  const j = value.job;
  if (action === 'report' && j.status === 'done') return j.report ?? '(no report)';
  const head = `Research #${j.id} — ${j.status}${j.phase && j.phase !== j.status ? `, ${j.phase}` : ''}${j.progress ? ` (${j.progress})` : ''}`;
  const extra = value.started === false && value.reason ? ` Not started: ${value.reason}.` : value.started ? ' Running in the background; you will be told when it ends.' : '';
  const err = j.error ? ` Error: ${j.error}` : '';
  return `${head}: ${j.blocksDone}/${j.blocks} parts researched, ${j.citations} sources, ${j.callsUsed} model calls.${extra}${err}`;
}
