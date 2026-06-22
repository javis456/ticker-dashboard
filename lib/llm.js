// Shared server-side LLM helper.
// Routes calls to the right provider based on a model string like
// "anthropic:claude-sonnet-4-5-20250929" or "deepseek:deepseek-chat".
//
// Returns a normalized shape so callers don't have to know which provider answered.
//
// Anthropic-specific features (prompt caching, web search) are silently dropped
// when a non-Anthropic provider is selected; calls still succeed, just without
// those optimizations.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEEPSEEK_API_KEY  = process.env.DEEPSEEK_API_KEY;

// Defaults used when caller doesn't supply a model.
export const DEFAULT_COMPLEX_MODEL = 'anthropic:claude-sonnet-4-5-20250929';
export const DEFAULT_SIMPLE_MODEL  = 'anthropic:claude-haiku-4-5-20251001';

// Approximate USD-per-million-token rates. Used for cost estimates returned to
// the client. Falls back to Anthropic Sonnet pricing for unknown models — these
// numbers are informational, not billing.
const PRICING = {
  'anthropic:claude-sonnet-4-5-20250929':   { in: 3.0,  cachedIn: 0.30, cacheCreate: 3.75, out: 15.0 },
  'anthropic:claude-haiku-4-5-20251001':    { in: 1.0,  cachedIn: 0.10, cacheCreate: 1.25, out:  5.0 },
  'deepseek:deepseek-chat':                 { in: 0.27, cachedIn: 0.07, cacheCreate: 0,    out:  1.10 },
  'deepseek:deepseek-reasoner':             { in: 0.55, cachedIn: 0.14, cacheCreate: 0,    out:  2.19 },
};

export function parseModel(modelStr) {
  if (!modelStr || typeof modelStr !== 'string') return null;
  const i = modelStr.indexOf(':');
  if (i === -1) return null;
  return { provider: modelStr.slice(0, i).toLowerCase(), modelId: modelStr.slice(i + 1) };
}

export function providerOf(modelStr) {
  return parseModel(modelStr)?.provider || null;
}

export function isAnthropic(modelStr) { return providerOf(modelStr) === 'anthropic'; }
export function isDeepSeek(modelStr)  { return providerOf(modelStr) === 'deepseek'; }

// Single entry point.
// opts:
//   model:           required, "provider:modelId" string
//   system:          string — system instructions
//   messages:        [{role, content}] — content can be string or Anthropic-style blocks
//   max_tokens:      number, default 2000
//   temperature:     0..1
//   enableCaching:   boolean — wraps system in cache_control for Anthropic. Ignored elsewhere.
//   webSearchMaxUses:number — enables Anthropic web search tool with N uses. Ignored elsewhere.
//   responseFormatJson: boolean — for DeepSeek/OpenAI-compatible, requests JSON-mode.
//                       For Anthropic, has no effect (we prompt for JSON in the system message).
export async function callLLM(opts) {
  const parsed = parseModel(opts.model);
  if (!parsed) throw new Error(`Invalid model string: ${opts.model}`);

  if (parsed.provider === 'anthropic') return callAnthropic(parsed.modelId, opts);
  if (parsed.provider === 'deepseek')  return callDeepSeek(parsed.modelId, opts);
  throw new Error(`Unknown provider: ${parsed.provider}`);
}

async function callAnthropic(modelId, opts) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const { system, messages, max_tokens = 2000, temperature, enableCaching, webSearchMaxUses } = opts;

  const body = {
    model: modelId,
    max_tokens,
    messages: messages || [],
  };
  if (temperature !== undefined) body.temperature = temperature;

  if (system) {
    body.system = enableCaching
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  }

  if (webSearchMaxUses && webSearchMaxUses > 0) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: webSearchMaxUses }];
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Anthropic ${r.status}: ${errText.slice(0, 400)}`);
  }

  const data = await r.json();
  const text = (data.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text || '')
    .join('\n')
    .trim();
  const searchUses = (data.content || []).filter(c => c.type === 'server_tool_use').length;

  return {
    text,
    rawContent: data.content,
    stopReason: data.stop_reason,
    usage: {
      input_tokens:                data.usage?.input_tokens ?? 0,
      output_tokens:               data.usage?.output_tokens ?? 0,
      cache_read_input_tokens:     data.usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
    },
    searchUses,
    provider: 'anthropic',
    modelId,
  };
}

async function callDeepSeek(modelId, opts) {
  if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured');

  const { system, messages = [], max_tokens = 2000, temperature, responseFormatJson } = opts;

  // Anthropic-style messages can have either string content or arrays of blocks.
  // DeepSeek (OpenAI-compatible) expects plain string content.
  const flatMessages = [];
  if (system) flatMessages.push({ role: 'system', content: String(system) });

  for (const m of messages) {
    let content;
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .map(b => typeof b === 'string' ? b : (b.type === 'text' ? b.text : ''))
        .join('\n');
    } else {
      content = String(m.content ?? '');
    }
    flatMessages.push({ role: m.role, content });
  }

  const body = {
    model: modelId,
    messages: flatMessages,
    max_tokens,
  };
  if (temperature !== undefined) body.temperature = temperature;
  if (responseFormatJson) body.response_format = { type: 'json_object' };

  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`DeepSeek ${r.status}: ${errText.slice(0, 400)}`);
  }

  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || '';
  const stopReason = data.choices?.[0]?.finish_reason || null;
  // Normalize stop reasons to roughly match Anthropic's vocabulary
  const normalizedStop =
    stopReason === 'stop'   ? 'end_turn' :
    stopReason === 'length' ? 'max_tokens' :
    stopReason;

  return {
    text,
    rawContent: [{ type: 'text', text }],
    stopReason: normalizedStop,
    usage: {
      input_tokens:                data.usage?.prompt_tokens ?? 0,
      output_tokens:               data.usage?.completion_tokens ?? 0,
      cache_read_input_tokens:     data.usage?.prompt_cache_hit_tokens ?? 0,
      cache_creation_input_tokens: 0,
    },
    searchUses: 0,
    provider: 'deepseek',
    modelId,
  };
}

// Compute approximate USD cost from a usage block returned by callLLM.
export function estimateCost(modelStr, usage, searchUses = 0) {
  const rates = PRICING[modelStr] || PRICING[DEFAULT_COMPLEX_MODEL];
  const u = usage || {};
  const inTok   = (u.input_tokens || 0) - (u.cache_read_input_tokens || 0) - (u.cache_creation_input_tokens || 0);
  const cost =
    (Math.max(0, inTok) / 1_000_000) * rates.in +
    ((u.cache_read_input_tokens || 0)     / 1_000_000) * rates.cachedIn +
    ((u.cache_creation_input_tokens || 0) / 1_000_000) * rates.cacheCreate +
    ((u.output_tokens || 0)               / 1_000_000) * rates.out +
    (searchUses * 0.01);   // Anthropic web search is $0.01/use
  return Number(cost.toFixed(4));
}
