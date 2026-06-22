// Vercel serverless function: GET /api/list-models
//
// Returns the live list of available models from each configured provider.
// New models appear automatically when providers publish them.
//
// Response: { providers: [{ id, name, configured, models: [...] }] }
//   models[].id           — full model string for use in API calls (e.g. "anthropic:claude-sonnet-4-5-20250929")
//   models[].display_name — human-readable label
//   models[].provider     — "anthropic" | "deepseek"
//   models[].created_at   — ISO string when known
//
// Cached at the CDN edge for 1 hour (stale-while-revalidate for 1 day).

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEEPSEEK_API_KEY  = process.env.DEEPSEEK_API_KEY;

async function fetchAnthropicModels() {
  if (!ANTHROPIC_API_KEY) {
    return {
      id: 'anthropic', name: 'Anthropic', configured: false, models: [],
      configure_hint: 'Add ANTHROPIC_API_KEY to your Vercel environment variables.',
    };
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      }
    });
    if (!r.ok) {
      const text = await r.text();
      return { id: 'anthropic', name: 'Anthropic', configured: true, models: [], error: `${r.status}: ${text.slice(0, 200)}` };
    }
    const data = await r.json();
    const models = (data.data || []).map(m => ({
      id: `anthropic:${m.id}`,
      provider: 'anthropic',
      display_name: m.display_name || m.id,
      created_at: m.created_at || null,
    }));
    // Sort newest first
    models.sort((a, b) => {
      if (a.created_at && b.created_at) return b.created_at.localeCompare(a.created_at);
      if (a.created_at) return -1;
      if (b.created_at) return 1;
      return a.display_name.localeCompare(b.display_name);
    });
    return { id: 'anthropic', name: 'Anthropic', configured: true, models };
  } catch (e) {
    return { id: 'anthropic', name: 'Anthropic', configured: true, models: [], error: String(e.message || e) };
  }
}

async function fetchDeepSeekModels() {
  if (!DEEPSEEK_API_KEY) {
    return {
      id: 'deepseek', name: 'DeepSeek', configured: false, models: [],
      configure_hint: 'Add DEEPSEEK_API_KEY to your Vercel environment variables.',
    };
  }
  try {
    const r = await fetch('https://api.deepseek.com/models', {
      headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` }
    });
    if (!r.ok) {
      const text = await r.text();
      return { id: 'deepseek', name: 'DeepSeek', configured: true, models: [], error: `${r.status}: ${text.slice(0, 200)}` };
    }
    const data = await r.json();
    const models = (data.data || []).map(m => ({
      id: `deepseek:${m.id}`,
      provider: 'deepseek',
      // DeepSeek doesn't provide display_name; we give a friendly one
      display_name: prettifyDeepSeekName(m.id),
      created_at: m.created ? new Date(m.created * 1000).toISOString() : null,
    }));
    models.sort((a, b) => a.display_name.localeCompare(b.display_name));
    return { id: 'deepseek', name: 'DeepSeek', configured: true, models };
  } catch (e) {
    return { id: 'deepseek', name: 'DeepSeek', configured: true, models: [], error: String(e.message || e) };
  }
}

function prettifyDeepSeekName(id) {
  // "deepseek-chat" → "DeepSeek Chat"; "deepseek-reasoner" → "DeepSeek Reasoner"
  return id.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

  const [anth, ds] = await Promise.all([
    fetchAnthropicModels(),
    fetchDeepSeekModels(),
  ]);

  res.status(200).json({ providers: [anth, ds] });
}
