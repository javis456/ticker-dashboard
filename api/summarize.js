// Vercel serverless function: POST /api/summarize
// Generates a structured summary for a ticker + period + topic using Claude Sonnet.
// Cost-optimized:
//  - prompt caching on the static instructions (90% discount on cached input tokens)
//  - web_search only enabled for periods >= 1 month (Finnhub usually has enough for shorter)
//  - max_tokens capped at 1500
//
// Input body:
// {
//   ticker:  "AMD",
//   period:  "1d" | "1w" | "1m" | "1q" | "custom",
//   periodLabel: "1 week",
//   fromDate: "2026-05-08",  // ISO date string
//   toDate:   "2026-05-15",
//   topic:    "overall" | "product" | "custom",
//   customTopic: "",            // when topic === "custom"
//   priceContext: { startPx, endPx, pctChange, high, low },
//   newsItems: [{ headline, source, datetime, url, summary }]  // pre-filtered to period
// }

const SYSTEM_INSTRUCTIONS = `You are a financial news analyst writing a structured summary for a personal stock dashboard.

OUTPUT FORMAT — strict JSON, no preamble, no markdown fences:

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
    "Specific prediction or expected action with timeline, derived from news context (e.g., 'Earnings report due May 22 — analysts watching data center segment growth')"
  ],
  "events_timeline": [
    {"when": "May 22, 2026", "what": "Q1 earnings report"},
    {"when": "Next 3 weeks", "what": "Neutron rocket launch (per Reuters)"}
  ],
  "product_focus": null
}

RULES:
- Return 2-5 items in "key_news" — only genuinely important stories, not filler
- Each key_news item MUST have at least one source link from the news provided
- "future_predictions" and "events_timeline" should only contain items grounded in the news. If no clear future events are mentioned, return empty arrays.
- If topic is "product", also fill "product_focus" with a 3-5 sentence section specifically about product news (launches, updates, milestones, achievements). Otherwise leave it null.
- If topic is custom, focus the analysis around the custom topic while still including all standard sections.
- Be specific. No generic statements like "the stock had a volatile week." Reference actual events.
- NEVER fabricate URLs. Only use URLs that appear in the news provided or in your web search results.`;

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

  // Format news for the prompt
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

  // Web search only for longer periods (cost optimization)
  // For 1d / 1w, Finnhub data is usually sufficient
  const enableWebSearch = ['1m', '1q', 'custom'].includes(period);

  const userMessage = `Summarize ${ticker} for the period ${fromDate} to ${toDate} (${periodLabel}).

${topicHint}

${priceLine}

News items from Finnhub for this period:
${newsBlock}

${enableWebSearch ? 'You may also use web_search to find additional context if the news above is insufficient (especially for older periods).' : 'Use only the news provided above.'}

Return the JSON summary now.`;

  const tools = enableWebSearch ? [{
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3, // Hard cap on searches per summary
  }] : undefined;

  try {
    const body = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1500,
      system: [
        {
          type: 'text',
          text: SYSTEM_INSTRUCTIONS,
          cache_control: { type: 'ephemeral' }, // 90% discount on repeated calls
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
      return res.status(502).json({ error: 'Summary generation failed', details: errText });
    }

    const data = await response.json();

    // Combine all text blocks (web search may inject multiple)
    const text = data.content
      ?.filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('')
      .trim() || '';

    // Strip code fences if present
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error('JSON parse failed:', text);
      return res.status(502).json({ error: 'Could not parse summary response', raw: text });
    }

    // Cost reporting
    const usage = data.usage || {};
    const inputTokens         = usage.input_tokens || 0;
    const cachedInputTokens   = usage.cache_read_input_tokens || 0;
    const cacheCreateTokens   = usage.cache_creation_input_tokens || 0;
    const outputTokens        = usage.output_tokens || 0;
    const searchUses          = data.content?.filter(c => c.type === 'server_tool_use').length || 0;

    // Sonnet 4.5 pricing
    const inputCost     = (inputTokens / 1_000_000) * 3.0;
    const cachedCost    = (cachedInputTokens / 1_000_000) * 0.30;
    const cacheCreateCost = (cacheCreateTokens / 1_000_000) * 3.75;
    const outputCost    = (outputTokens / 1_000_000) * 15.0;
    const searchCost    = searchUses * 0.01;
    const totalCost     = inputCost + cachedCost + cacheCreateCost + outputCost + searchCost;

    res.status(200).json({
      summary: parsed,
      meta: {
        tokens:    { input: inputTokens, cached: cachedInputTokens, output: outputTokens, cacheCreate: cacheCreateTokens },
        searches:  searchUses,
        costUSD:   Number(totalCost.toFixed(4)),
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
