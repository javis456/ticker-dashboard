// Vercel serverless function: POST /api/summarize
// Generates a structured summary using the user-selected complex model.

import { callLLM, estimateCost, isAnthropic, DEFAULT_COMPLEX_MODEL } from '../lib/llm.js';

const SYSTEM_INSTRUCTIONS = `You are a financial news analyst writing a structured summary for a personal stock dashboard.

OUTPUT FORMAT — return ONLY a valid JSON object, nothing else. No preamble, no markdown code fences, no explanation. The very first character of your response must be { and the very last must be }.

The JSON must follow this exact structure:

{
  "headline_summary": "One-line tl;dr of the period (max 20 words)",
  "key_news": [
    {
      "headline": "Bold short title of the most important story",
      "description": "2-3 sentence description capturing the main facts",
      "sources": [{"title": "Source name", "url": "https://..."}]
    }
  ],
  "sentiment": {
    "rating": "Bullish" | "Bearish" | "Mixed" | "Neutral",
    "explanation": "2-3 sentences explaining market sentiment"
  },
  "price_performance": "What happened to the price, with explanation. 2-3 sentences.",
  "future_predictions": ["Specific prediction with timeline"],
  "events_timeline": [{"when": "May 22, 2026", "what": "Q1 earnings report"}],
  "product_focus": null
}

CRITICAL LENGTH RULES — keep the JSON compact:
- "key_news" should have 3-5 items max. Each "description" is 2-3 sentences ONLY.
- "future_predictions" is 2-4 short bullets max
- "events_timeline" is 2-5 entries max
- "product_focus" (when filled) is 3-4 sentences, NOT a long essay
- Be concise. Density over volume.

CRITICAL FORMATTING RULES:
- DO NOT include any XML or HTML tags inside string values (no <cite>, <source>, <ref>, etc.)
- DO NOT wrap text in citation markers — sources go in the "sources" array only
- Plain text only inside string values
- NEVER fabricate URLs. Only use URLs from the news provided or web search results.

RULES:
- Each key_news item MUST have at least one source link
- If topic is "product", fill "product_focus". Otherwise null.
- If topic is custom, tilt analysis toward the custom topic while keeping standard sections.
- Output must be parseable JSON. No trailing commas, no comments, no markdown fences.`;

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

function planTokenBudget(period, topic, newsCount) {
  let budget = 2000;
  if (period === '1m')     budget += 800;
  if (period === '1q')     budget += 1500;
  if (period === 'custom') budget += 1500;
  if (topic === 'product') budget += 800;
  if (topic === 'custom')  budget += 500;
  if (newsCount > 15) budget += 500;
  if (newsCount > 25) budget += 500;
  return Math.min(budget, 6000);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const {
    ticker, period, periodLabel, fromDate, toDate,
    topic, customTopic, priceContext, newsItems = [],
    model,    // NEW: user-selected model from client
  } = req.body || {};

  if (!ticker || !period || !fromDate || !toDate) {
    return res.status(400).json({ error: 'ticker, period, fromDate, toDate required' });
  }

  const selectedModel = model || DEFAULT_COMPLEX_MODEL;

  const newsBlock = newsItems.length === 0
    ? "(No news items provided from Finnhub for this period.)"
    : newsItems.slice(0, 25).map((n, i) =>
        `[${i + 1}] ${new Date((n.datetime || 0) * 1000).toISOString().slice(0, 10)} | ${n.source || 'Unknown'}
HEADLINE: ${n.headline}
SUMMARY: ${(n.summary || '').slice(0, 400)}
URL: ${n.url || 'N/A'}`
      ).join('\n\n');

  const topicHint = topic === 'product'
    ? `Topic focus: PRODUCT — emphasize product launches, milestones, achievements, customer wins. Fill "product_focus" (3-4 sentences max).`
    : topic === 'custom'
      ? `Topic focus: CUSTOM — "${customTopic || 'general'}". Tilt analysis around this topic while keeping all standard sections.`
      : 'Topic focus: OVERALL — cover all material developments.';

  const priceLine = priceContext && priceContext.startPx
    ? `Price context: started at $${priceContext.startPx?.toFixed(2)}, ended at $${priceContext.endPx?.toFixed(2)} (${priceContext.pctChange > 0 ? '+' : ''}${priceContext.pctChange?.toFixed(2)}%). High: $${priceContext.high?.toFixed(2)}, Low: $${priceContext.low?.toFixed(2)}.`
    : 'Price context: unavailable.';

  // Web search is only available with Anthropic models
  const enableWebSearch = isAnthropic(selectedModel) && ['1m', '1q', 'custom'].includes(period);

  const webHint = enableWebSearch
    ? 'You may use web_search up to 3 times for additional context.'
    : 'Use only the news provided above.';

  const userMessage = `Summarize ${ticker} for ${fromDate} to ${toDate} (${periodLabel}).

${topicHint}

${priceLine}

News items from Finnhub:
${newsBlock}

${webHint}

Output the JSON summary now. Be CONCISE — short descriptions, dense facts. Your response MUST start with { and end with }. No code fences. NO XML tags inside string values.`;

  const maxTokens = planTokenBudget(period, topic, newsItems.length);

  try {
    const llmResult = await callLLM({
      model: selectedModel,
      system: SYSTEM_INSTRUCTIONS,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: maxTokens,
      enableCaching: isAnthropic(selectedModel),    // Anthropic-only optimization
      webSearchMaxUses: enableWebSearch ? 3 : 0,    // Anthropic-only
      responseFormatJson: !isAnthropic(selectedModel), // DeepSeek/OpenAI-compatible JSON mode
    });

    const { text, stopReason, usage, searchUses } = llmResult;
    let parsed = extractJSON(text);
    let wasSalvaged = false;
    if (!parsed && stopReason === 'max_tokens') {
      parsed = salvageTruncatedJSON(text);
      if (parsed) wasSalvaged = true;
    }

    if (!parsed) {
      console.error('JSON extraction failed. stop_reason:', stopReason, 'Raw:', text.slice(0, 800));
      return res.status(502).json({
        error: stopReason === 'max_tokens'
          ? `Response exceeded token budget (${maxTokens}). Try a shorter period or simpler topic.`
          : 'Could not parse summary response',
        stopReason,
        maxTokensUsed: maxTokens,
        rawPreview: text.slice(0, 1000),
        model: selectedModel,
      });
    }

    parsed = cleanCitations(parsed);

    const costUSD = estimateCost(selectedModel, usage, searchUses);

    res.status(200).json({
      summary: parsed,
      meta: {
        model:    selectedModel,
        provider: llmResult.provider,
        tokens:   {
          input:       usage.input_tokens,
          cached:      usage.cache_read_input_tokens,
          output:      usage.output_tokens,
          cacheCreate: usage.cache_creation_input_tokens,
        },
        searches: searchUses,
        costUSD,
        stopReason,
        maxTokensUsed: maxTokens,
        salvaged: wasSalvaged,
      }
    });
  } catch (e) {
    console.error('summarize error:', e);
    res.status(500).json({ error: String(e.message || e), model: selectedModel });
  }
}
