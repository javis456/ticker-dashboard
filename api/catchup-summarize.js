// Vercel serverless function: POST /api/catchup-summarize
// Generates a structured catchup summary for a Catchup card.
//
// Inputs: card definition (name, type, tickers, topics, key_interests, routine)
// Plus pre-fetched news from Finnhub for the relevant tickers
//
// Output: structured JSON with sections tuned for habit-building catchup

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

// ─── Strip citation tags ──────────────────────────────────────────────────────
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

// ─── JSON extraction & salvage ────────────────────────────────────────────────
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
  let depth = 0, inString = false, escape = false;
  let lastSafeEnd = -1;
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

// ─── Token budget ─────────────────────────────────────────────────────────────
function planTokenBudget({ routineUnit, type, tickerCount, topicCount }) {
  let budget = 1800;
  if (routineUnit === 'week')  budget += 600;
  if (routineUnit === 'month') budget += 1400;
  if (type === 'stocks_and_topics') budget += 400;
  // More entities → potentially more updates
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

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });

  const {
    cardName,
    type,                // 'stocks' | 'topics' | 'stocks_and_topics'
    tickers = [],
    topics = [],
    keyInterests = '',
    routineValue = 1,
    routineUnit = 'week',
    fromDate, toDate,
    newsByTicker = {},   // { TICKER: [news items] }
  } = req.body || {};

  if (!type || !fromDate || !toDate) {
    return res.status(400).json({ error: 'type, fromDate, toDate required' });
  }

  // Build the news block — group news by ticker for clarity
  let newsBlock = '(no news provided)';
  const allNews = Object.entries(newsByTicker).flatMap(([tk, items]) =>
    (items || []).map(n => ({ ...n, ticker: tk }))
  );

  if (allNews.length > 0) {
    // Cap total news items to keep prompt size bounded
    const capped = allNews.slice(0, 40);
    newsBlock = capped.map((n, i) =>
      `[${i + 1}] ${new Date((n.datetime || 0) * 1000).toISOString().slice(0, 10)} | $${n.ticker} | ${n.source || 'Unknown'}
HEADLINE: ${n.headline}
SUMMARY: ${(n.summary || '').slice(0, 350)}
URL: ${n.url || 'N/A'}`
    ).join('\n\n');
  }

  // Build the focus directive based on type
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
  // Enable web search for topic-heavy queries or longer periods
  const enableWebSearch = type !== 'stocks' || periodDays >= 14;

  const userMessage = `Generate a "${cardName}" catchup briefing for ${fromDate} → ${toDate} (a ${routineValue}-${routineUnit} routine).

${focusBlock}

News items from Finnhub for the relevant tickers (may be empty if topic-only):
${newsBlock}

${enableWebSearch ? 'You MAY use web_search up to 3 times to find topic-relevant news or fill gaps.' : 'Use ONLY the news provided above.'}

Output the JSON briefing now. Be CONCISE and SPECIFIC. NO XML tags inside string values. Start with { end with }.`;

  const tools = enableWebSearch ? [{
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
  }] : undefined;

  const maxTokens = planTokenBudget({
    routineUnit, type,
    tickerCount: tickers.length,
    topicCount:  topics.length,
  });

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
      return res.status(502).json({ error: 'Anthropic call failed', details: errText });
    }

    const data = await response.json();
    const stopReason = data.stop_reason;

    const allText = data.content
      ?.filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('\n')
      .trim() || '';

    let parsed = extractJSON(allText);
    let salvaged = false;
    if (!parsed && stopReason === 'max_tokens') {
      parsed = salvageTruncatedJSON(allText);
      if (parsed) salvaged = true;
    }

    if (!parsed) {
      return res.status(502).json({
        error: stopReason === 'max_tokens'
          ? `Response exceeded token budget (${maxTokens}). Try a shorter routine or fewer tickers/topics.`
          : 'Could not parse catchup response',
        stopReason, maxTokensUsed: maxTokens,
        rawPreview: allText.slice(0, 1000),
      });
    }

    parsed = cleanCitations(parsed);

    // Cost reporting
    const usage = data.usage || {};
    const inputCost       = ((usage.input_tokens || 0) / 1_000_000) * 3.0;
    const cachedCost      = ((usage.cache_read_input_tokens || 0) / 1_000_000) * 0.30;
    const cacheCreateCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * 3.75;
    const outputCost      = ((usage.output_tokens || 0) / 1_000_000) * 15.0;
    const searches        = data.content?.filter(c => c.type === 'server_tool_use').length || 0;
    const searchCost      = searches * 0.01;
    const totalCost       = inputCost + cachedCost + cacheCreateCost + outputCost + searchCost;

    res.status(200).json({
      briefing: parsed,
      meta: {
        tokens: {
          input:       usage.input_tokens || 0,
          cached:      usage.cache_read_input_tokens || 0,
          cacheCreate: usage.cache_creation_input_tokens || 0,
          output:      usage.output_tokens || 0,
        },
        searches,
        costUSD: Number(totalCost.toFixed(4)),
        stopReason,
        salvaged,
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
