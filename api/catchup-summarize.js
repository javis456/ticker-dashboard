// Vercel serverless function: POST /api/catchup-summarize
// Generates a structured catchup briefing using the user-selected complex model.

import { callLLM, estimateCost, isAnthropic, DEFAULT_COMPLEX_MODEL } from '../lib/llm.js';
import { checkQuota, commitUsage } from '../lib/quota.js';

const SYSTEM_INSTRUCTIONS = `You are a financial news analyst writing a catchup briefing for a personal stock dashboard. The user has set up a recurring routine to stay caught up on specific stocks and/or topics.

OUTPUT FORMAT — return ONLY a valid JSON object. Start with { end with }. No preamble, no markdown, no code fences.

Structure:

{
  "tldr": "One-line summary of the period (max 25 words)",
  "key_updates": [
    {
      "title": "Short bold title of the update",
      "summary": "2-3 sentence summary with concrete facts",
      "related": ["NVDA"],
      "sources": [{"title": "Source name", "url": "https://..."}]
    }
  ],
  "key_elements": [
    "Key element or theme observed during this period (1 sentence each)"
  ],
  "what_to_watch": [
    "Specific thing to monitor going forward (1 sentence each)"
  ],
  "next_events": [
    {"when": "May 22, 2026", "what": "AMD Q1 earnings"}
  ]
}

LENGTH RULES — be compact:
- "key_updates": 3-6 items max, each summary 2-3 sentences ONLY
- "key_elements": 2-4 bullets
- "what_to_watch": 2-4 bullets
- "next_events": 2-5 entries max
- Density over volume

CONTENT RULES:
- Each key_update MUST have at least one source link
- "related" array: list ticker symbols (uppercased) most relevant to that update
- Focus on the user's stated type and key interests — that's what they care about
- NEVER fabricate URLs. Only use URLs from provided news or web search results
- Plain text inside string values — NO XML tags like <cite> or <source>
- No trailing commas. No markdown fences. Just JSON.`;

function cleanCitations(value) {
  if (typeof value === 'string') {
    return value
      .replace(/<cite\s+[^>]*>([\s\S]*?)<\/cite>/gi, '$1')
      .replace(/<\/?cite[^>]*>/gi, '')
      .replace(/<(source|ref|citation)\s+[^>]*>([\s\S]*?)<\/\1>/gi, '$2')
      .replace(/<\/?(source|ref|citation)[^>]*>/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  if (Array.isArray(value)) return value.map(cleanCitations);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = cleanCitations(value[k]);
    return out;
  }
  return value;
}

function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = firstBrace; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(firstBrace, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function salvageTruncatedJSON(text) {
  if (!text) return null;
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  let s = text.slice(firstBrace);
  let depth = 0, inString = false, escape = false, lastSafeEnd = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    if (!inString && (c === ',' || c === '}' || c === ']')) lastSafeEnd = i + 1;
  }
  if (lastSafeEnd === -1) return null;
  let trimmed = s.slice(0, lastSafeEnd).replace(/,\s*$/, '');
  let openBraces = 0, openBrackets = 0;
  inString = false; escape = false;
  for (const c of trimmed) {
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') openBraces++;
    else if (c === '}') openBraces--;
    else if (c === '[') openBrackets++;
    else if (c === ']') openBrackets--;
  }
  while (openBrackets > 0) { trimmed += ']'; openBrackets--; }
  while (openBraces   > 0) { trimmed += '}'; openBraces--;   }
  try { return JSON.parse(trimmed); } catch { return null; }
}

function planTokenBudget({ routineUnit, type, tickerCount, topicCount }) {
  let budget = 1800;
  if (routineUnit === 'week')  budget += 600;
  if (routineUnit === 'month') budget += 1400;
  if (type === 'stocks_and_topics') budget += 400;
  budget += Math.min(tickerCount * 100, 600);
  budget += Math.min(topicCount  * 150, 600);
  return Math.min(budget, 5500);
}

function periodToDays(value, unit) {
  if (unit === 'day')   return value;
  if (unit === 'week')  return value * 7;
  if (unit === 'month') return value * 30;
  return value;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const {
    cardName, type, tickers = [], topics = [], keyInterests = '',
    routineValue = 1, routineUnit = 'week',
    fromDate, toDate, newsByTicker = {},
    model,   // NEW
  } = req.body || {};

  if (!type || !fromDate || !toDate) {
    return res.status(400).json({ error: 'type, fromDate, toDate required' });
  }

  // ── Tier quota enforcement (server-side, authoritative) ──────────────────
  const accessToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const quota = await checkQuota(accessToken, 'catchup');
  if (!quota.allowed) {
    return res.status(429).json({ error: quota.reason, upgrade: true });
  }

  const selectedModel = model || DEFAULT_COMPLEX_MODEL;

  let newsBlock = '(no news provided)';
  const allNews = Object.entries(newsByTicker).flatMap(([tk, items]) =>
    (items || []).map(n => ({ ...n, ticker: tk }))
  );
  if (allNews.length > 0) {
    const capped = allNews.slice(0, 40);
    newsBlock = capped.map((n, i) =>
      `[${i + 1}] ${new Date((n.datetime || 0) * 1000).toISOString().slice(0, 10)} | $${n.ticker} | ${n.source || 'Unknown'}
HEADLINE: ${n.headline}
SUMMARY: ${(n.summary || '').slice(0, 350)}
URL: ${n.url || 'N/A'}`
    ).join('\n\n');
  }

  let focusBlock = '';
  if (type === 'stocks') {
    focusBlock = `FOCUS: Stocks only. Cover news about these tickers: ${tickers.join(', ')}.`;
  } else if (type === 'topics') {
    focusBlock = `FOCUS: Topics only. Filter for news related to these topics: ${topics.join('; ')}. Use web search to find topic-relevant news beyond what's provided.`;
  } else {
    focusBlock = `FOCUS: Intersection of these stocks AND topics. Tickers: ${tickers.join(', ')}. Topics: ${topics.join('; ')}. Only include updates that connect a listed ticker to a listed topic.`;
  }

  if (keyInterests && keyInterests.trim()) {
    focusBlock += `\nKey interests to weight heavily: ${keyInterests.trim()}`;
  }

  const periodDays = periodToDays(routineValue, routineUnit);
  // Web search only available with Anthropic models
  const enableWebSearch = isAnthropic(selectedModel) && (type !== 'stocks' || periodDays >= 14);

  const webHint = enableWebSearch
    ? 'You MAY use web_search up to 3 times to find topic-relevant news or fill gaps.'
    : 'Use ONLY the news provided above.';

  const userMessage = `Generate a "${cardName}" catchup briefing for ${fromDate} → ${toDate} (a ${routineValue}-${routineUnit} routine).

${focusBlock}

News items from Finnhub for the relevant tickers (may be empty if topic-only):
${newsBlock}

${webHint}

Output the JSON briefing now. Be CONCISE and SPECIFIC. NO XML tags inside string values. Start with { end with }.`;

  const maxTokens = planTokenBudget({
    routineUnit, type,
    tickerCount: tickers.length,
    topicCount:  topics.length,
  });

  try {
    const llmResult = await callLLM({
      model: selectedModel,
      system: SYSTEM_INSTRUCTIONS,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: maxTokens,
      enableCaching: isAnthropic(selectedModel),
      webSearchMaxUses: enableWebSearch ? 3 : 0,
      responseFormatJson: !isAnthropic(selectedModel),
    });

    const { text, stopReason, usage, searchUses } = llmResult;
    let parsed = extractJSON(text);
    let salvaged = false;
    if (!parsed && stopReason === 'max_tokens') {
      parsed = salvageTruncatedJSON(text);
      if (parsed) salvaged = true;
    }
    if (!parsed) {
      return res.status(502).json({
        error: stopReason === 'max_tokens'
          ? `Response exceeded token budget (${maxTokens}). Try a shorter routine or fewer tickers/topics.`
          : 'Could not parse catchup response',
        stopReason, maxTokensUsed: maxTokens,
        rawPreview: text.slice(0, 1000),
        model: selectedModel,
      });
    }
    parsed = cleanCitations(parsed);

    // Count this successful Catchup against the user's all-time quota.
    await commitUsage(quota.profile, 'catchup', quota.period);

    const costUSD = estimateCost(selectedModel, usage, searchUses);

    res.status(200).json({
      briefing: parsed,
      meta: {
        model:    selectedModel,
        provider: llmResult.provider,
        tokens: {
          input:       usage.input_tokens,
          cached:      usage.cache_read_input_tokens,
          cacheCreate: usage.cache_creation_input_tokens,
          output:      usage.output_tokens,
        },
        searches: searchUses,
        costUSD,
        stopReason,
        salvaged,
      }
    });
  } catch (e) {
    console.error('catchup-summarize error:', e);
    res.status(500).json({ error: String(e.message || e), model: selectedModel });
  }
}

