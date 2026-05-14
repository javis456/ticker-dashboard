// Vercel serverless function: POST /api/tag-news
// Receives up to ~30 headlines, returns tags for each.
// Your ANTHROPIC_API_KEY is set as a server-side env var in Vercel
// (NOT VITE_ prefixed, so it never reaches the browser).

const TAG_DEFINITIONS = `
Available tags and their definitions:
- Earnings: quarterly/annual earnings reports, revenue or EPS results from the company
- Analysis: analyst notes, ratings changes, price targets, buy/sell/hold recommendations
- Price Surge: stock price jumped up significantly, soared, high buying volume
- Price Fall: stock price fell, dropped, high selling volume
- Achievement: company achieved a goal, completed a major task, successful milestone, successful M&A, contract signed
- Shock: surprising news (positive or negative), unusual/rare event, very strong sentiment in either direction
- Deal: company made a deal/partnership/agreement with another party
- Good News: news with positive sentiment toward the stock (broad)
- Bad News: news with negative sentiment toward the stock (broad)
- Products: news about products — new product launches, product successes/failures

Rules:
- Each headline can have MULTIPLE tags
- "Good News" or "Bad News" should usually accompany narrower tags (e.g., Earnings + Good News if earnings beat)
- Only assign Shock when something is genuinely surprising or rare
- If nothing fits, return ["Other"]
- Be precise — only tag what's clearly indicated by the headline
`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { headlines } = req.body || {};
  if (!Array.isArray(headlines) || headlines.length === 0) {
    return res.status(400).json({ error: 'headlines array required' });
  }
  if (headlines.length > 50) {
    return res.status(400).json({ error: 'max 50 headlines per call' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Build a numbered list. AI returns JSON indexed by the same numbers.
  const numbered = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');

  const prompt = `${TAG_DEFINITIONS}

Tag each of these financial news headlines. Return ONLY a JSON object mapping each number to an array of tags. No preamble, no explanation, no markdown.

Example response format:
{"1": ["Earnings", "Good News"], "2": ["Analysis"], "3": ["Shock", "Bad News"]}

Headlines:
${numbered}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // Cheapest + fastest, perfect for classification
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: 'Tagging failed', details: errText });
    }

    const data = await response.json();
    const text = data.content?.map(c => c.text || '').join('').trim() || '';

    // Strip markdown code fences if Claude wrapped the JSON
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      console.error('JSON parse failed. Raw response:', text);
      return res.status(502).json({ error: 'Could not parse tagging response' });
    }

    // Map numbered keys back to headline indices (0-based)
    const result = {};
    headlines.forEach((h, i) => {
      result[i] = parsed[String(i + 1)] || ['Other'];
    });

    res.status(200).json({ tags: result });
  } catch (e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
