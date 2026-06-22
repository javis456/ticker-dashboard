// Vercel serverless function: POST /api/tag-news
// Receives up to ~50 headlines, returns tags for each.
// Uses the user-selected SIMPLE model (default: Anthropic Haiku 4.5).

import { callLLM, isAnthropic, DEFAULT_SIMPLE_MODEL } from '../lib/llm.js';

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { headlines, model } = req.body || {};
  if (!Array.isArray(headlines) || headlines.length === 0) {
    return res.status(400).json({ error: 'headlines array required' });
  }
  if (headlines.length > 50) return res.status(400).json({ error: 'max 50 headlines per call' });

  const selectedModel = model || DEFAULT_SIMPLE_MODEL;

  const numbered = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');

  const prompt = `${TAG_DEFINITIONS}

Tag each of these financial news headlines. Return ONLY a JSON object mapping each number to an array of tags. No preamble, no explanation, no markdown.

Example response format:
{"1": ["Earnings", "Good News"], "2": ["Analysis"], "3": ["Shock", "Bad News"]}

Headlines:
${numbered}`;

  try {
    const llmResult = await callLLM({
      model: selectedModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      // For DeepSeek, JSON mode helps ensure structured output.
      // For Anthropic, prompt is strong enough — no JSON mode needed.
      responseFormatJson: !isAnthropic(selectedModel),
      temperature: 0.2,
    });

    const text = llmResult.text || '';
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      console.error('JSON parse failed. Raw response:', text.slice(0, 500));
      return res.status(502).json({ error: 'Could not parse tagging response', model: selectedModel });
    }

    const result = {};
    headlines.forEach((h, i) => {
      result[i] = parsed[String(i + 1)] || ['Other'];
    });

    res.status(200).json({
      tags: result,
      meta: { model: selectedModel, provider: llmResult.provider },
    });
  } catch (e) {
    console.error('tag-news error:', e);
    res.status(500).json({ error: String(e.message || e), model: selectedModel });
  }
}
