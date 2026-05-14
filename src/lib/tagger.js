// Tagger: takes news headlines, returns tags.
// - Caches results in Supabase (one row per headline hash) so each headline is tagged ONCE
// - Batches uncached headlines, sends to /api/tag-news, stores results

import { supabase } from './supabase';

export const AVAILABLE_TAGS = [
  'Earnings', 'Analysis', 'Price Surge', 'Price Fall',
  'Achievement', 'Shock', 'Deal', 'Good News', 'Bad News', 'Products',
];

// Tag → emoji + color (used by NewsCard badges)
export const TAG_STYLES = {
  'Earnings':     { color: '#0369a1', bg: '#e0f2fe' },
  'Analysis':     { color: '#6d28d9', bg: '#ede9fe' },
  'Price Surge':  { color: '#15803d', bg: '#dcfce7' },
  'Price Fall':   { color: '#b91c1c', bg: '#fee2e2' },
  'Achievement':  { color: '#a16207', bg: '#fef3c7' },
  'Shock':        { color: '#be185d', bg: '#fce7f3' },
  'Deal':         { color: '#0f766e', bg: '#ccfbf1' },
  'Good News':    { color: '#166534', bg: '#dcfce7' },
  'Bad News':     { color: '#991b1b', bg: '#fee2e2' },
  'Products':     { color: '#1e40af', bg: '#dbeafe' },
  'Other':        { color: '#525252', bg: '#f0f0ec' },
};

// Hash a headline → a stable short key so we can cache regardless of source
async function hashHeadline(headline) {
  const data = new TextEncoder().encode(headline.trim().toLowerCase());
  const buf = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// Look up cached tags for a list of headlines
async function loadCachedTags(hashes) {
  if (!supabase || hashes.length === 0) return {};
  const { data, error } = await supabase
    .from('news_tags')
    .select('headline_hash, tags')
    .in('headline_hash', hashes);
  if (error) {
    console.warn('[Tagger] cache lookup failed', error);
    return {};
  }
  const map = {};
  (data || []).forEach(r => { map[r.headline_hash] = r.tags; });
  return map;
}

async function saveCachedTags(rows) {
  if (!supabase || rows.length === 0) return;
  const { error } = await supabase.from('news_tags').upsert(rows);
  if (error) console.warn('[Tagger] cache save failed', error);
}

// Main entry: tag a list of news items. Returns { [newsKey]: [tags] }
// `items` should be [{ key, headline }]
export async function tagNews(items) {
  if (!items || items.length === 0) return {};

  // Step 1: hash everything
  const withHashes = await Promise.all(
    items.map(async it => ({ ...it, hash: await hashHeadline(it.headline) }))
  );

  // Step 2: look up cache
  const cached = await loadCachedTags(withHashes.map(it => it.hash));

  // Step 3: figure out who needs tagging
  const result = {};
  const needsTagging = [];
  withHashes.forEach(it => {
    if (cached[it.hash]) {
      result[it.key] = cached[it.hash];
    } else {
      needsTagging.push(it);
    }
  });

  if (needsTagging.length === 0) return result;

  // Step 4: batch the uncached headlines (30 per request)
  const BATCH_SIZE = 30;
  const newCacheRows = [];

  for (let i = 0; i < needsTagging.length; i += BATCH_SIZE) {
    const batch = needsTagging.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch('/api/tag-news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headlines: batch.map(b => b.headline) }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.warn('[Tagger] batch failed', res.status, err);
        // Mark these as Other so we don't keep retrying
        batch.forEach(it => { result[it.key] = ['Other']; });
        continue;
      }
      const data = await res.json();
      batch.forEach((it, idx) => {
        const tags = data.tags?.[idx] || ['Other'];
        result[it.key] = tags;
        newCacheRows.push({ headline_hash: it.hash, headline: it.headline, tags });
      });
    } catch (e) {
      console.warn('[Tagger] batch error', e);
      batch.forEach(it => { result[it.key] = ['Other']; });
    }
  }

  // Step 5: save new tags to cache (fire and forget)
  if (newCacheRows.length > 0) saveCachedTags(newCacheRows);

  return result;
}
