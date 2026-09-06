// Build first, then run with OPENROUTER_API_KEY set:
// node scripts/probe-models.mjs x-ai/grok-4.5 meta/muse-glimmer-30b
import { ModelPlayer } from '../packages/arena/dist/model-player.js';
import { loadRoster } from '../packages/arena/dist/registry.js';
import {
  DEFAULT_ANSWER_TIMEOUT_MS,
  DEFAULT_THRIPLASH_TIMEOUT_MS,
  DEFAULT_VOTE_TIMEOUT_MS,
} from '../packages/jackbox/dist/quiplash3.js';

const slugs = process.argv.slice(2);
if (!slugs.length) throw new Error('Provide one or more roster model slugs.');
if (!process.env.OPENROUTER_API_KEY) throw new Error('Set OPENROUTER_API_KEY before probing.');
const { models } = await loadRoster();
const selected = slugs.map(slug => {
  const model = models.find(entry => entry.slug === slug);
  if (!model) throw new Error(`Unknown roster model: ${slug}`);
  return model;
});

for (const model of selected) {
  let trace;
  let failed;
  const player = new ModelPlayer({
    model: model.slug,
    displayName: model.displayName,
    reasoning: model.reasoning,
    reasoningMandatory: model.reasoningMandatory,
    reasoningPrompt: model.reasoningPrompt,
    ...(model.temperature === null ? {} : { temperature: model.temperature }),
    onFailure: () => { failed = true; },
    logger: {
      error: () => { failed = true; },
      warn: message => { if (message.includes('could not parse vote')) failed = true; },
    },
    sink: event => { if (event.type === 'trace.completed') trace = event; },
  });
  for (const [purpose, budgetMs] of [
    ['answer', DEFAULT_ANSWER_TIMEOUT_MS],
    ['vote', DEFAULT_VOTE_TIMEOUT_MS],
    ['thriplash', DEFAULT_THRIPLASH_TIMEOUT_MS],
  ]) {
    trace = undefined;
    failed = false;
    const ctx = {
      gameId: 'roster-preflight',
      round: purpose === 'thriplash' ? 3 : 1,
      deadlineMs: Date.now() + budgetMs,
      maxLength: 45,
    };
    const started = Date.now();
    let answer;
    try {
      answer = purpose === 'answer'
        ? await player.answer('A deodorant scent designed by a dog', ctx)
        : purpose === 'vote'
          ? await player.vote('The worst thing to discover in your pocket', [
            'A smaller, angrier pair of pants', 'A receipt for this pocket',
          ], ctx)
          : await player.answerFinal('Three warning signs your dog is the landlord', ctx);
    } catch {
      failed = true;
    }
    const values = Array.isArray(answer) ? answer : [answer];
    const valid = purpose === 'vote'
      ? Number.isInteger(answer) && answer >= 0 && answer < 2
      : values.length === (purpose === 'thriplash' ? 3 : 1)
        && values.every(value => typeof value === 'string' && value.trim()
          && value !== 'no comment' && value.length <= 45);
    const passed = Boolean(valid && !failed);
    console.log(JSON.stringify({
      model: model.slug, purpose, budgetMs, passed, answer,
      elapsedMs: Date.now() - started,
      attempts: trace?.attempts,
    }));
    if (!passed) process.exitCode = 1;
  }
}
