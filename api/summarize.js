// Vercel serverless function: POST /api/summarize
// Generates a structured summary for a ticker + period + topic using Claude Sonnet.

const SYSTEM_INSTRUCTIONS = `You are a financial news analyst writing a structured summary for a personal stock dashboard.

OUTPUT FORMAT — return ONLY a valid JSON object, nothing else. No preamble, no markdown code fences, no explanation. The very first character of your response must be { and the very last must be }.

The JSON must follow this exact structure:

{
  "headline_summary": "One-line tl;dr of the period (max 20 words)",
  "key_news": [
    {
      "headline": "Bold short title of the most important story",
      "description": "2-3 sentence description capturing the main facts of this story",
      "sources": [{"title": "Source name", "url": "https://..."}]
    }
  ],
  "sentiment": {
    "rating": "Bullish" | "Bearish" | "Mixed" | "Neutral",
    "explanation": "2-3 sentences explaining the market sentiment during this period"
  },
  "price_performance": "Description of what happened to the price during this period, with explanation for the move if news supports it. 2-3 sentences.",
  "future_predictions": [
    "Specific prediction or expected action with timeline (e.g., 'Earnings report due May 22 — analysts watching data center segment growth')"
  ],
  "events_timeline": [
    {"when": "May 22, 2026", "what": "Q1 earnings report"}
  ],
  "product_focus": null
}

RULES:
- Return 2-5 items in "key_news" — only genuinely important stories, not filler
- Each key_news item MUST have at least one source link
- "future_predictions" and "events_timeline" should only contain items grounded in the news. If none, return empty arrays.
- If topic is "product", fill "product_focus" with a 3-5 sentence section specifically about product news.
- If topic is custom, focus the analysis around the custom topic while still including all standard sections.
- Be specific. No generic statements. Reference actual events.
- NEVER fabricate URLs. Only use URLs that appear in the news provided or in web search results.
- CRITICAL: Output must be parseable JSON. No trailing commas, no comments, no markdown.`;

// ─── Robust JSON extraction ───────────────────────────────────────────────────
function extractJSON(text) {
  if (!text) return null;

  // Strategy 1: Try parsing as-is
  try { return JSON.parse(text.trim()); } catch {}

  // Strategy 2: Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  // Strategy 3: Find the first { and match to its closing } using brace counting
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

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
        const candidate = text.slice(firstBrace, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }

  return null;
}

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
    ? `Topic focus: PRODUCT — emphasize product launches, releases, milestones, achievements, customer wins. Fill "product_focus" in the JSON.`
    : topic === 'custom'
      ? `Topic focus: CUSTOM — "${customTopic || 'general'}". Tilt the analysis around this topic while still covering all sections.`
      : 'Topic focus: OVERALL — cover all material developments.';

  const priceLine = priceContext && priceContext.startPx
    ? `Price context: started at $${priceContext.startPx?.toFixed(2)}, ended at $${priceContext.endPx?.toFixed(2)} (${priceContext.pctChange > 0 ? '+' : ''}${priceContext.pctChange?.toFixed(2)}%). High: $${priceContext.high?.toFixed(2)}, Low: $${priceContext.low?.toFixed(2)}.`
    : 'Price context: unavailable.';

  const enableWebSearch = ['1m', '1q', 'custom'].includes(period);

  const userMessage = `Summarize ${ticker} for the period ${fromDate} to ${toDate} (${periodLabel}).

${topicHint}

${priceLine}

News items from Finnhub for this period:
${newsBlock}

${enableWebSearch ? 'You may use web_search to find additional context if needed.' : 'Use only the news provided above.'}

Now output the JSON summary. Remember: your response MUST be ONLY valid JSON, starting with { and ending with }.`;

  const tools = enableWebSearch ? [{
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
  }] : undefined;

  try {
    const body = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2500, // increased to avoid mid-JSON truncation
      system: [
        {
          type: 'text',
          text: SYSTEM_INSTRUCTIONS,
          cache_control: { type: 'ephemeral' },
        }
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

    // Combine all text blocks (web search injects multiple blocks)
    const allText = data.content
      ?.filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('\n')
      .trim() || '';

    // Robust extraction
    const parsed = extractJSON(allText);

    if (!parsed) {
      console.error('JSON extraction failed. Raw text:', allText.slice(0, 500));
      return res.status(502).json({
        error: 'Could not parse summary response',
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
      }
    });
  } catch (e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
