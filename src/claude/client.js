// The one place the assistant calls Claude. Every call:
// - is counted against a daily call limit (CLAUDE_DAILY_CALL_LIMIT),
// - is recorded with its token usage (llm_calls table, shown in /status),
// - puts the stable instructions first with a cache breakpoint, so a long
//   PMO context file is cached across calls (short prompts are below the
//   minimum cacheable size and simply aren't cached — no extra cost),
// - opts into server-side refusal fallbacks.
// Callers catch errors and fall back to rule-based text.

import { logger } from '../logger.js';
import { localToday } from '../jira/classify.js';

const log = logger.child({ component: 'claude' });

export class ClaudeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClaudeUnavailableError';
  }
}

export function createClaude({ store, apiKey, model, enabled, dailyCallLimit = 40, pmoContext = '', client = null }) {
  let sdk = client;
  const active = Boolean(client) || Boolean(enabled && apiKey);

  return {
    enabled: active,
    model,

    // Returns { text, json? }. With `schema`, the reply is constrained to that JSON schema.
    async complete({ purpose, system, user, effort = 'low', schema = null, maxTokens = 16000 }) {
      if (!active) throw new ClaudeUnavailableError('Claude is disabled (set CLAUDE_ENABLED=true and ANTHROPIC_API_KEY)');
      const since = new Date(`${localToday()}T00:00:00`).toISOString();
      const used = store.llmUsageSince(since).calls;
      if (used >= dailyCallLimit) throw new ClaudeUnavailableError(`Daily Claude call limit reached (${dailyCallLimit})`);

      if (!sdk) {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        sdk = new Anthropic({ apiKey });
      }

      const systemBlocks = [{ type: 'text', text: system }];
      if (pmoContext) systemBlocks.push({ type: 'text', text: `Background about my work:\n${pmoContext}` });
      systemBlocks.at(-1).cache_control = { type: 'ephemeral' };

      const started = Date.now();
      let response;
      try {
        response = await sdk.beta.messages.create({
          model,
          max_tokens: maxTokens,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: systemBlocks,
          messages: [{ role: 'user', content: user }],
          output_config: { effort, ...(schema && { format: { type: 'json_schema', schema } }) },
        });
      } catch (err) {
        store.recordLlmCall({ purpose, model, ms: Date.now() - started, ok: false, error: err.message });
        log.error('claude call failed', { purpose, status: err.status, error: err.message });
        throw err;
      }

      const ms = Date.now() - started;
      if (response.stop_reason === 'refusal') {
        store.recordLlmCall({ purpose, model: response.model, usage: response.usage, ms, ok: false, error: 'refusal' });
        throw new Error(`Claude declined (${response.stop_details?.category ?? 'no category'})`);
      }
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (!text) {
        store.recordLlmCall({ purpose, model: response.model, usage: response.usage, ms, ok: false, error: `empty (${response.stop_reason})` });
        throw new Error(`Empty Claude response (stop_reason ${response.stop_reason})`);
      }

      store.recordLlmCall({ purpose, model: response.model, usage: response.usage, ms, ok: true });
      log.info('claude call', {
        purpose, ms, inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens,
        cacheReadTokens: response.usage?.cache_read_input_tokens,
      });
      return { text, json: schema ? JSON.parse(text) : undefined };
    },
  };
}
