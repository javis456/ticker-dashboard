// Vercel serverless function: POST /api/summarize
// Generates a structured summary using Claude Sonnet.

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
- Be concise. Density over volume. Truncating beats overflowing.

RULES:
- Each key_news item MUST have at least one source link
- If topic is "product", fill "product_focus". Otherwise null.
- If topic is custom, tilt analysis toward the custom topic while keeping standard sections.
- NEVER fabricate URLs. Only use URLs from the news provided or web search results.
- Output must be parseable JSON. No trailing commas, no comments, no markdown fences.`;

// ─── Robust JSON extraction ───────────────────────────────────────────────────
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

// ─── Salvage partial JSON when response was truncated ─────────────────────────
// If the AI ran out of tokens mid-JSON, try to close it up.
function salvageTruncatedJSON(text) {
  if (!text) return null;
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  let s = text.slice(firstBrace);

  // Walk forward, tracking depth, strings, escapes. Note where we stopped.
  let depth = 0, inString = false, escape = false;
  let lastSafeEnd = -1; // index after last position where structure is "safe to truncate"

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    // Safe point: after a comma at any depth, or after a closing brace at depth 1+
    if (!inString && (c === ',' || c === '}' || c === ']')) {
      lastSafeEnd = i + 1;
    }
  }

  if (lastSafeEnd === -1) return null;

  // Trim to last safe boundary, strip trailing comma, then close all open structures
  let trimmed = s.slice(0, lastSafeEnd).replace(/,\s*$/, '');

  // Count unclosed braces/brackets
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

  // Close brackets first (inner), then braces (outer)
  while (openBrackets > 0) { trimmed += ']'; openBrackets--; }
  while (openBraces   > 0) { trimmed += '}'; openBraces--;   }

  try { return JSON.parse(trimmed); } catch { return null; }
}

// ─── Token budget planning ────────────────────────────────────────────────────
function planTokenBudget(period, topic, newsCount) {
  // Base budget
  let budget = 2000;

  // Longer periods → more news to discuss → more output
  if (period === '1m')     budget += 800;
  if (period === '1q')     budget += 1500;
  if (period === 'custom') budget += 1500;

  // Product topic adds a whole extra section
  if (topic === 'product') budget += 800;
  if (topic === 'custom')  budget += 500;

  // More news items → more output
  if (newsCount > 15) budget += 500;
  if (newsCount > 25) budget += 500;

  // Hard ceiling (Sonnet max_tokens limit is high, but we don't want to pay for runaway output)
  return Math.min(budget, 6000);
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });

  const {
    ticker, period, periodLabel, fromDate, toDate,
    topic, customTopic, priceContext, newsItems = []
  } = req.body || {};

  if (!ticker || !period || !fromDate || !toDate) {
    return res.status(400).json({ error: 'ticker, period, fromDate, toDate required' });
  }

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

  const enableWebSearch = ['1m', '1q', 'custom'].includes(period);

  const userMessage = `Summarize ${ticker} for ${fromDate} to ${toDate} (${periodLabel}).

${topicHint}

${priceLine}

News items from Finnhub:
${newsBlock}

${enableWebSearch ? 'You may use web_search up to 3 times for additional context.' : 'Use only the news provided above.'}

Output the JSON summary now. Be CONCISE — short descriptions, dense facts. Your response MUST start with { and end with }. No code fences.`;

  const tools = enableWebSearch ? [{
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
  }] : undefined;

  const maxTokens = planTokenBudget(period, topic, newsItems.length);

  try {
    const body = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: maxTokens,
      system: [
        { type: 'text', text: SYSTEM_INSTRUCTIONS, cache_control: { type: 'ephemeral' } }
      ],
      messages: [{ role: 'user', content: userMessage }],
    };
    if (tools) body.tools = tools;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic error:', response.status, errText);
      return res.status(502).json({ error: 'Anthropic API call failed', details: errText });
    }

    const data = await response.json();
    const stopReason = data.stop_reason; // "end_turn" | "max_tokens" | "tool_use" | ...

    const allText = data.content
      ?.filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('\n')
      .trim() || '';

    // Try clean parse first
    let parsed = extractJSON(allText);

    // If clean parse failed AND response was truncated, try to salvage
    let wasSalvaged = false;
    if (!parsed && stopReason === 'max_tokens') {
      parsed = salvageTruncatedJSON(allText);
      if (parsed) wasSalvaged = true;
    }

    if (!parsed) {
      console.error('JSON extraction failed. stop_reason:', stopReason, 'Raw preview:', allText.slice(0, 800));
      return res.status(502).json({
        error: stopReason === 'max_tokens'
          ? `Response exceeded token budget (${maxTokens}). Try a shorter period or simpler topic.`
          : 'Could not parse summary response',
        stopReason,
        maxTokensUsed: maxTokens,
        rawPreview: allText.slice(0, 1000),
      });
    }

    // Cost reporting
    const usage = data.usage || {};
    const inputTokens         = usage.input_tokens || 0;
    const cachedInputTokens   = usage.cache_read_input_tokens || 0;
    const cacheCreateTokens   = usage.cache_creation_input_tokens || 0;
    const outputTokens        = usage.output_tokens || 0;
    const searchUses          = data.content?.filter(c => c.type === 'server_tool_use').length || 0;

    const inputCost       = (inputTokens / 1_000_000) * 3.0;
    const cachedCost      = (cachedInputTokens / 1_000_000) * 0.30;
    const cacheCreateCost = (cacheCreateTokens / 1_000_000) * 3.75;
    const outputCost      = (outputTokens / 1_000_000) * 15.0;
    const searchCost      = searchUses * 0.01;
    const totalCost       = inputCost + cachedCost + cacheCreateCost + outputCost + searchCost;

    res.status(200).json({
      summary: parsed,
      meta: {
        tokens:    { input: inputTokens, cached: cachedInputTokens, output: outputTokens, cacheCreate: cacheCreateTokens },
        searches:  searchUses,
        costUSD:   Number(totalCost.toFixed(4)),
        stopReason,
        maxTokensUsed: maxTokens,
        salvaged:  wasSalvaged,
      }
    });
  } catch (e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}

