import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  TrendingUp, TrendingDown, Plus, X, Star, Bookmark, Search, FolderPlus,
  ChevronRight, Bell, RefreshCw, ExternalLink, Cloud, CloudOff, Copy, Check,
  Sparkles, Filter, Eye, Trash2, AlertCircle, Tag, Layers
} from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { getQuote, getProfile, getNews, getCandles, classifyImpact, timeAgo } from "./lib/finnhub";
import { supabase, getIdentity, setIdentity, loadState, saveState } from "./lib/supabase";
import { tagNews, AVAILABLE_TAGS, TAG_STYLES } from "./lib/tagger";

// ─── Default state ────────────────────────────────────────────────────────────
const DEFAULT_STATE = {
  sectorGroups: [
    { id: "s1", name: "Technology",    tickers: ["NVDA", "AMD", "AAPL", "MSFT", "GOOGL"] },
    { id: "s2", name: "Consumer",      tickers: [] },
    { id: "s3", name: "Energy",        tickers: [] },
    { id: "s4", name: "EV / Mobility", tickers: ["TSLA"] },
  ],
  customGroups: [
    { id: "g1", name: "AI & Semis",    tickers: ["NVDA", "AMD"] },
    { id: "g2", name: "My Watchlist",  tickers: ["AAPL", "MSFT", "GOOGL", "TSLA"] },
  ],
  selected:    "NVDA",
  activeTab:   "sector",   // "sector" | "custom"
  activeGroup: "s1",
  pinned:      {},
  watchKeywords: [],        // [{ id, keyword, createdAt }]
  watchMatches:  {},        // { matchId: { keyword, ticker, news, matchedAt } }
};

const REMINDER_DAYS = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatTimestamp(unixSeconds) {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  if (isToday) return timeStr;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " + timeStr;
}

function matchesKeyword(keyword, news) {
  const kw = keyword.toLowerCase();
  const haystack = [
    news.headline  || "",
    news.summary   || "",
  ].join(" ").toLowerCase();
  return haystack.includes(kw);
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="px-3 py-2 rounded-lg text-xs shadow-lg" style={{ background: "white", border: "1px solid #ececec" }}>
      <div className="opacity-50 mb-0.5">{label}</div>
      <div className="font-semibold text-sm">${payload[0].value?.toFixed(2)}</div>
    </div>
  );
}

function PriceChart({ symbol, isUp }) {
  const [candles, setCandles] = useState([]);
  const [range, setRange]     = useState(6);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!symbol) return;
    setLoading(true);
    getCandles(symbol, range)
      .then(data => setCandles(data))
      .catch(() => setCandles([]))
      .finally(() => setLoading(false));
  }, [symbol, range]);

  const color   = isUp ? "#059669" : "#dc2626";
  const fillId  = `fill-${symbol}`;
  const minC    = useMemo(() => candles.length ? Math.min(...candles.map(c => c.close)) * 0.995 : 0, [candles]);
  const maxC    = useMemo(() => candles.length ? Math.max(...candles.map(c => c.close)) * 1.005 : 0, [candles]);
  const tickInterval = Math.max(1, Math.floor(candles.length / 6));

  if (loading) return <div className="h-36 flex items-center justify-center opacity-30 text-xs">Loading chart…</div>;
  if (!candles.length) return <div className="h-36 flex items-center justify-center opacity-30 text-xs">Chart unavailable</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] tracking-widest uppercase opacity-40">Price history</span>
        <div className="flex items-center gap-1">
          {[1, 3, 6].map(m => (
            <button key={m} onClick={() => setRange(m)}
              className="text-[11px] px-2 py-0.5 rounded-full transition-all font-medium"
              style={{ background: range === m ? "#1a1a1a" : "#f0f0ec", color: range === m ? "white" : "#525252" }}>
              {m}M
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={candles} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={color} stopOpacity={0.15} />
              <stop offset="100%" stopColor={color} stopOpacity={0}    />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#a3a3a3" }} tickLine={false} axisLine={false} interval={tickInterval} />
          <YAxis domain={[minC, maxC]} tick={{ fontSize: 10, fill: "#a3a3a3" }} tickLine={false} axisLine={false} tickFormatter={v => `$${v.toFixed(0)}`} width={48} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#e5e5e5", strokeWidth: 1 }} />
          <Area type="monotone" dataKey="close" stroke={color} strokeWidth={1.5} fill={`url(#${fillId})`} dot={false} activeDot={{ r: 3, fill: color, strokeWidth: 0 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function GroupRow({ active, onClick, onRemove, name, count }) {
  return (
    <div onClick={onClick} className="group cursor-pointer flex items-center justify-between px-3 py-2 rounded-lg transition-all text-sm"
      style={{ background: active ? "#1a1a1a" : "transparent", color: active ? "#fafaf7" : "#1a1a1a" }}>
      <div className="flex items-center gap-2 min-w-0">
        <ChevronRight size={12} style={{ opacity: active ? 1 : 0.3, flexShrink: 0 }} />
        <span className="font-medium truncate">{name}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] opacity-60">{count}</span>
        {onRemove && (
          <button onClick={e => { e.stopPropagation(); onRemove(); }} className="opacity-0 group-hover:opacity-40 hover:opacity-100 transition">
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

function ConfirmModal({ title, message, onConfirm, onCancel }) {
  return (
    <div onClick={onCancel} className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-sm rounded-2xl p-6 fade-in" style={{ background: "white" }}>
        <div className="flex items-center gap-3 mb-2">
          <AlertCircle size={20} style={{ color: "#dc2626", flexShrink: 0 }} />
          <h3 className="font-serif-h text-lg font-semibold">{title}</h3>
        </div>
        <p className="text-sm opacity-60 mb-5 ml-8">{message}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 py-2 rounded-md text-sm" style={{ background: "#f0f0ec" }}>Cancel</button>
          <button onClick={onConfirm} className="flex-1 py-2 rounded-md text-sm text-white" style={{ background: "#dc2626" }}>Delete</button>
        </div>
      </div>
    </div>
  );
}

function NewsCard({ news, tags, pinned, onPin, onSelect, onTagClick }) {
  return (
    <article className="rounded-xl p-5 group" style={{ background: "white", border: "1px solid #ececec" }}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <button onClick={onSelect} className="text-xs font-bold px-2 py-0.5 rounded-md hover:bg-gray-200" style={{ background: "#f0f0ec" }}>${news.ticker}</button>
            <span className="text-[11px] opacity-50">{news.source}</span>
            <span className="text-[11px] opacity-30">·</span>
            <span className="text-[11px] opacity-50">{formatTimestamp(news.datetime)}</span>
          </div>
          <a href={news.url} target="_blank" rel="noreferrer" className="font-serif-h text-lg font-semibold leading-snug mb-1.5 hover:underline block">{news.headline}</a>
          {news.summary && <p className="text-sm opacity-60 leading-relaxed line-clamp-2 mb-2">{news.summary}</p>}
          {tags?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {tags.map(tag => {
                const style = TAG_STYLES[tag] || TAG_STYLES.Other;
                return (
                  <button key={tag} onClick={() => onTagClick?.(tag)}
                    className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider hover:opacity-80 transition"
                    style={{ background: style.bg, color: style.color }}>
                    {tag}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button onClick={onPin} className="flex-shrink-0 p-1.5 rounded-full opacity-40 group-hover:opacity-100 hover:bg-gray-100 transition">
          <Star size={16} fill={pinned ? "#fbbf24" : "none"} stroke={pinned ? "#fbbf24" : "currentColor"} />
        </button>
      </div>
    </article>
  );
}

function SyncModal({ onClose }) {
  const [id] = useState(getIdentity());
  const [draft, setDraft] = useState(id);
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(id); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const apply = () => { if (!draft.trim()) return; setIdentity(draft.trim()); window.location.reload(); };
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-md rounded-2xl p-6 fade-in" style={{ background: "white" }}>
        <h3 className="font-serif-h text-xl font-semibold mb-2">Sync across devices</h3>
        <p className="text-sm opacity-60 mb-4">Copy this ID, then open Ticker on another device and paste it in to share the same data.</p>
        <label className="text-xs font-semibold tracking-widest uppercase opacity-50">Your sync ID</label>
        <div className="flex gap-2 mt-1 mb-4">
          <input readOnly value={id} className="flex-1 text-xs font-mono px-3 py-2 rounded-md" style={{ background: "#f7f7f3", border: "1px solid #e5e5e5" }} />
          <button onClick={copy} className="px-3 py-2 rounded-md text-white text-xs flex items-center gap-1" style={{ background: "#1a1a1a" }}>
            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
          </button>
        </div>
        <label className="text-xs font-semibold tracking-widest uppercase opacity-50">Paste a sync ID</label>
        <input value={draft} onChange={e => setDraft(e.target.value)} className="w-full text-xs font-mono px-3 py-2 rounded-md mt-1" style={{ background: "#f7f7f3", border: "1px solid #e5e5e5" }} />
        <div className="flex gap-2 mt-4">
          <button onClick={apply} className="flex-1 py-2 rounded-md text-white text-sm" style={{ background: "#1a1a1a" }}>Use this ID</button>
          <button onClick={onClose} className="px-4 py-2 rounded-md text-sm" style={{ background: "#f0f0ec" }}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [state, setState]       = useState(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [cloudStatus, setCloudStatus] = useState("connecting");

  const [quotes, setQuotes]         = useState({});
  const [profiles, setProfiles]     = useState({});
  const [newsByTicker, setNewsByTicker] = useState({});
  const [loadingTicker, setLoadingTicker] = useState({});

  const [tagsByNewsKey, setTagsByNewsKey] = useState({});
  const [activeTags, setActiveTags]       = useState([]);
  const [showFilter, setShowFilter]       = useState(false);
  const [taggingInProgress, setTaggingInProgress] = useState(false);

  const [showAddTicker, setShowAddTicker] = useState(false);
  const [showAddGroup, setShowAddGroup]   = useState(false);
  const [showSync, setShowSync]           = useState(false);
  const [newTicker, setNewTicker]         = useState("");
  const [newTickerGroup, setNewTickerGroup] = useState("");
  const [newGroupName, setNewGroupName]   = useState("");
  const [search, setSearch]   = useState("");
  const [view, setView]       = useState("feed"); // feed | pinned | watching

  // Delete confirmation
  const [confirmDelete, setConfirmDelete] = useState(null); // { type: 'ticker'|'group', id, label }

  // Watching
  const [newKeyword, setNewKeyword] = useState("");

  // Hydrate
  useEffect(() => {
    (async () => {
      if (!supabase) { setCloudStatus("offline"); setHydrated(true); return; }
      try {
        const saved = await loadState();
        if (saved) setState(prev => ({
          ...DEFAULT_STATE,
          ...saved,
          // Ensure new keys exist if loading old saved state
          sectorGroups:  saved.sectorGroups  || DEFAULT_STATE.sectorGroups,
          customGroups:  saved.customGroups  || DEFAULT_STATE.customGroups,
          watchKeywords: saved.watchKeywords || [],
          watchMatches:  saved.watchMatches  || {},
          activeTab:     saved.activeTab     || "sector",
        }));
        setCloudStatus("synced");
      } catch { setCloudStatus("offline"); }
      setHydrated(true);
    })();
  }, []);

  useEffect(() => { if (hydrated) saveState(state); }, [state, hydrated]);

  // Derived: all unique tickers across both group types
  const allTickers = useMemo(() => {
    const s = new Set();
    [...(state.sectorGroups || []), ...(state.customGroups || [])].forEach(g => g.tickers.forEach(t => s.add(t)));
    return [...s];
  }, [state.sectorGroups, state.customGroups]);

  const activeGroups = state.activeTab === "sector" ? (state.sectorGroups || []) : (state.customGroups || []);

  const displayedTickers = useMemo(() => {
    const g = activeGroups.find(g => g.id === state.activeGroup);
    return g ? g.tickers : [];
  }, [activeGroups, state.activeGroup]);

  // Load ticker data
  const loadTicker = useCallback(async (tk) => {
    setLoadingTicker(prev => ({ ...prev, [tk]: true }));
    try {
      const [q, p, n] = await Promise.all([
        getQuote(tk).catch(() => null),
        getProfile(tk).catch(() => ({})),
        getNews(tk, 7).catch(() => []),
      ]);
      if (q) setQuotes(prev => ({ ...prev, [tk]: q }));
      if (p) setProfiles(prev => ({ ...prev, [tk]: p }));
      const articles = (n || []).slice(0, 20).map(item => ({
        ...item, impact: classifyImpact(item.headline), tAgo: timeAgo(item.datetime),
      }));
      setNewsByTicker(prev => ({ ...prev, [tk]: articles }));
    } finally {
      setLoadingTicker(prev => ({ ...prev, [tk]: false }));
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    allTickers.forEach(tk => { if (!quotes[tk] && !loadingTicker[tk]) loadTicker(tk); });
  }, [hydrated, allTickers, quotes, loadingTicker, loadTicker]);

  useEffect(() => {
    if (!hydrated) return;
    const id = setInterval(() => {
      allTickers.forEach(tk => getQuote(tk).then(q => setQuotes(p => ({ ...p, [tk]: q }))).catch(() => {}));
    }, 60_000);
    return () => clearInterval(id);
  }, [hydrated, allTickers]);

  // Auto-tag
  useEffect(() => {
    if (!hydrated) return;
    const allItems = Object.entries(newsByTicker).flatMap(([tk, arr]) =>
      arr.map(n => ({ key: `${tk}_${n.id || n.url}`, headline: n.headline }))
    );
    const untagged = allItems.filter(it => !tagsByNewsKey[it.key]);
    if (!untagged.length) return;
    setTaggingInProgress(true);
    tagNews(untagged).then(tags => setTagsByNewsKey(prev => ({ ...prev, ...tags }))).finally(() => setTaggingInProgress(false));
  }, [hydrated, newsByTicker]); // eslint-disable-line

  // ── Keyword watching: scan new articles against keywords ──────────────────
  useEffect(() => {
    if (!hydrated || !state.watchKeywords?.length) return;
    const newMatches = {};
    allTickers.forEach(tk => {
      (newsByTicker[tk] || []).forEach(news => {
        state.watchKeywords.forEach(kw => {
          if (matchesKeyword(kw.keyword, news)) {
            const matchId = `${kw.id}_${news.id || news.url}`;
            if (!state.watchMatches?.[matchId]) {
              newMatches[matchId] = { keyword: kw.keyword, ticker: tk, news, matchedAt: Date.now() };
            }
          }
        });
      });
    });
    if (Object.keys(newMatches).length > 0) {
      updateState(s => ({ ...s, watchMatches: { ...(s.watchMatches || {}), ...newMatches } }));
    }
  }, [hydrated, newsByTicker, state.watchKeywords]); // eslint-disable-line

  // ── Derived news lists ────────────────────────────────────────────────────
  const visibleNews = useMemo(() => {
    let items = displayedTickers.flatMap(tk =>
      (newsByTicker[tk] || []).map(n => ({ ...n, ticker: tk, _key: `${tk}_${n.id || n.url}` }))
    );
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(n =>
        (n.headline || "").toLowerCase().includes(q) ||
        (n.summary  || "").toLowerCase().includes(q) ||
        n.ticker.toLowerCase().includes(q)
      );
    }
    if (activeTags.length > 0) {
      items = items.filter(n => {
        const tags = tagsByNewsKey[n._key] || [];
        return activeTags.some(t => tags.includes(t));
      });
    }
    return items.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
  }, [displayedTickers, newsByTicker, search, activeTags, tagsByNewsKey]);

  const pinnedItems   = useMemo(() => Object.values(state.pinned || {}).sort((a, b) => b.pinnedAt - a.pinnedAt), [state.pinned]);
  const watchItems    = useMemo(() => Object.values(state.watchMatches || {}).sort((a, b) => b.matchedAt - a.matchedAt), [state.watchMatches]);
  const newWatchCount = watchItems.length; // could track "seen" in future
  const remindersNeeded = pinnedItems.filter(p => (Date.now() - p.pinnedAt) / 86400000 >= REMINDER_DAYS);

  // ── Mutators ──────────────────────────────────────────────────────────────
  const updateState = fn => setState(prev => fn(prev));

  const setSelected    = tk  => updateState(s => ({ ...s, selected: tk }));
  const setActiveGroup = id  => updateState(s => ({ ...s, activeGroup: id }));
  const setActiveTab   = tab => {
    const groups = tab === "sector" ? state.sectorGroups : state.customGroups;
    updateState(s => ({ ...s, activeTab: tab, activeGroup: groups?.[0]?.id || "" }));
  };

  const togglePin = (ticker, news) => updateState(s => {
    const next = { ...s.pinned };
    const key  = String(news.id || news.url);
    if (next[key]) delete next[key]; else next[key] = { ticker, news, pinnedAt: Date.now(), key };
    return { ...s, pinned: next };
  });

  const addTicker = () => {
    const t = newTicker.trim().toUpperCase();
    if (!t) return;
    const targetId = newTickerGroup;
    updateState(s => {
      const updateGroups = (groups) => groups.map(g =>
        g.id === targetId && !g.tickers.includes(t) ? { ...g, tickers: [...g.tickers, t] } : g
      );
      return {
        ...s,
        sectorGroups: state.activeTab === "sector" ? updateGroups(s.sectorGroups) : s.sectorGroups,
        customGroups: state.activeTab === "custom" ? updateGroups(s.customGroups) : s.customGroups,
        selected: t,
      };
    });
    setNewTicker(""); setShowAddTicker(false);
    if (!quotes[t]) loadTicker(t);
  };

  const addGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    const id = "g" + Date.now();
    updateState(s => {
      if (state.activeTab === "sector") {
        return { ...s, sectorGroups: [...s.sectorGroups, { id, name, tickers: [] }], activeGroup: id };
      }
      return { ...s, customGroups: [...s.customGroups, { id, name, tickers: [] }], activeGroup: id };
    });
    setNewGroupName(""); setShowAddGroup(false);
  };

  // Deletion with confirmation
  const requestDeleteTicker = (tk) => {
    setConfirmDelete({ type: "ticker", id: tk, label: `$${tk}` });
  };
  const requestDeleteGroup = (gid, name) => {
    setConfirmDelete({ type: "group", id: gid, label: `"${name}"` });
  };
  const executeDelete = () => {
    if (!confirmDelete) return;
    if (confirmDelete.type === "ticker") {
      const tk = confirmDelete.id;
      updateState(s => ({
        ...s,
        sectorGroups: s.sectorGroups.map(g => ({ ...g, tickers: g.tickers.filter(t => t !== tk) })),
        customGroups: s.customGroups.map(g => ({ ...g, tickers: g.tickers.filter(t => t !== tk) })),
      }));
    } else {
      const gid = confirmDelete.id;
      updateState(s => {
        if (state.activeTab === "sector") {
          const next = s.sectorGroups.filter(g => g.id !== gid);
          return { ...s, sectorGroups: next, activeGroup: next[0]?.id || "" };
        }
        const next = s.customGroups.filter(g => g.id !== gid);
        return { ...s, customGroups: next, activeGroup: next[0]?.id || "" };
      });
    }
    setConfirmDelete(null);
  };

  // Watching keywords
  const addKeyword = () => {
    const kw = newKeyword.trim();
    if (!kw) return;
    const id = "kw" + Date.now();
    updateState(s => ({ ...s, watchKeywords: [...(s.watchKeywords || []), { id, keyword: kw, createdAt: Date.now() }] }));
    setNewKeyword("");
  };
  const removeKeyword = (id) => {
    updateState(s => ({
      ...s,
      watchKeywords: s.watchKeywords.filter(k => k.id !== id),
      watchMatches:  Object.fromEntries(Object.entries(s.watchMatches || {}).filter(([matchId]) => !matchId.startsWith(id + "_"))),
    }));
  };
  const removeWatchMatch = (matchId) => {
    updateState(s => {
      const next = { ...s.watchMatches };
      delete next[matchId];
      return { ...s, watchMatches: next };
    });
  };

  const toggleTag  = tag  => setActiveTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  const refreshAll = ()   => allTickers.forEach(loadTicker);

  const selected = state.selected;
  const quote    = quotes[selected]   || { c: 0, d: 0, dp: 0 };
  const profile  = profiles[selected] || {};
  const isUp     = (quote.d || 0) >= 0;
  const daysSince = ts => Math.floor((Date.now() - ts) / 86400000);

  // Init default group selection
  useEffect(() => {
    if (!hydrated) return;
    const groups = state.activeTab === "sector" ? state.sectorGroups : state.customGroups;
    if (!groups.find(g => g.id === state.activeGroup) && groups.length > 0) {
      updateState(s => ({ ...s, activeGroup: groups[0].id }));
    }
  }, [hydrated, state.activeTab]); // eslint-disable-line

  // Set default group target when add-ticker opens
  useEffect(() => {
    if (showAddTicker) {
      const groups = state.activeTab === "sector" ? state.sectorGroups : state.customGroups;
      setNewTickerGroup(state.activeGroup || groups[0]?.id || "");
    }
  }, [showAddTicker]); // eslint-disable-line

  return (
    <div className="min-h-screen w-full">
      {/* ── HEADER ── */}
      <header className="border-b sticky top-0 z-20 backdrop-blur-md" style={{ borderColor: "#ececec", background: "rgba(250,250,247,0.85)" }}>
        <div className="max-w-7xl mx-auto px-8 py-4 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-8">
            <div>
              <h1 className="font-serif-h text-2xl font-semibold tracking-tight">Ticker<span style={{ color: "#c2410c" }}>.</span></h1>
              <div className="text-[10px] tracking-[0.25em] uppercase opacity-50 mt-0.5">Your market, distilled</div>
            </div>
            <nav className="flex items-center gap-1">
              {[
                { id: "feed",     label: "Feed" },
                { id: "pinned",   label: "Pinned",   badge: pinnedItems.length },
                { id: "watching", label: "Watching", badge: newWatchCount, badgeColor: "#059669" },
              ].map(tab => (
                <button key={tab.id} onClick={() => setView(tab.id)}
                  className="px-3 py-1.5 text-sm rounded-full transition-all flex items-center gap-1.5"
                  style={{ background: view === tab.id ? "#1a1a1a" : "transparent", color: view === tab.id ? "#fafaf7" : "#1a1a1a" }}>
                  {tab.label}
                  {tab.badge > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full"
                      style={{
                        background: view === tab.id ? "#fafaf7" : (tab.badgeColor || "#1a1a1a"),
                        color: view === tab.id ? "#1a1a1a" : "#fafaf7",
                      }}>
                      {tab.badge}
                    </span>
                  )}
                </button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            {remindersNeeded.length > 0 && (
              <button onClick={() => setView("pinned")} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full" style={{ background: "#fef3c7", color: "#92400e" }}>
                <Bell size={12} /> {remindersNeeded.length} pinned need review
              </button>
            )}
            <button onClick={refreshAll} className="p-1.5 rounded-full hover:bg-gray-100 transition opacity-60 hover:opacity-100"><RefreshCw size={14} /></button>
            <button onClick={() => setShowSync(true)} className="p-1.5 rounded-full hover:bg-gray-100 transition"
              style={{ color: cloudStatus === "synced" ? "#059669" : cloudStatus === "offline" ? "#dc2626" : "#a3a3a3" }}>
              {cloudStatus === "offline" ? <CloudOff size={14} /> : <Cloud size={14} />}
            </button>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-40" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search news"
                className="pl-9 pr-3 py-1.5 text-sm rounded-full border focus:outline-none focus:border-gray-900 transition"
                style={{ borderColor: "#e5e5e5", background: "white", width: 200 }} />
            </div>
          </div>
        </div>
      </header>

      {showSync     && <SyncModal onClose={() => setShowSync(false)} />}
      {confirmDelete && (
        <ConfirmModal
          title={`Remove ${confirmDelete.label}?`}
          message={confirmDelete.type === "ticker"
            ? `${confirmDelete.label} will be removed from all groups. Your pinned news and watch matches for this ticker are kept.`
            : `The group ${confirmDelete.label} will be deleted. Tickers inside are not deleted — they remain in other groups.`}
          onConfirm={executeDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      <div className="max-w-7xl mx-auto px-8 py-8 grid grid-cols-12 gap-8">
        {/* ── SIDEBAR ── */}
        <aside className="col-span-3">
          {/* Group type tabs */}
          <div className="flex gap-1 mb-4 p-1 rounded-xl" style={{ background: "#f0f0ec" }}>
            <button onClick={() => setActiveTab("sector")}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-lg transition-all"
              style={{ background: state.activeTab === "sector" ? "white" : "transparent", color: "#1a1a1a", boxShadow: state.activeTab === "sector" ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}>
              <Layers size={11} /> Sector
            </button>
            <button onClick={() => setActiveTab("custom")}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-lg transition-all"
              style={{ background: state.activeTab === "custom" ? "white" : "transparent", color: "#1a1a1a", boxShadow: state.activeTab === "custom" ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}>
              <Tag size={11} /> Custom
            </button>
          </div>

          {/* Groups list */}
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold tracking-widest uppercase opacity-50">
              {state.activeTab === "sector" ? "Sectors" : "My Groups"}
            </h2>
            <button onClick={() => setShowAddGroup(true)} className="opacity-50 hover:opacity-100 transition"><FolderPlus size={14} /></button>
          </div>

          {showAddGroup && (
            <div className="mb-3 p-3 rounded-xl fade-in" style={{ background: "white", border: "1px solid #e5e5e5" }}>
              <input autoFocus value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addGroup()}
                placeholder={state.activeTab === "sector" ? "e.g. Healthcare" : "e.g. My speculative plays"}
                className="w-full text-sm focus:outline-none mb-2" />
              <div className="flex gap-1.5">
                <button onClick={addGroup} className="flex-1 text-xs py-1.5 rounded-md text-white" style={{ background: "#1a1a1a" }}>Create</button>
                <button onClick={() => setShowAddGroup(false)} className="px-3 text-xs py-1.5 rounded-md" style={{ background: "#f0f0ec" }}>Cancel</button>
              </div>
            </div>
          )}

          <div className="space-y-0.5 mb-5">
            {activeGroups.map(g => (
              <GroupRow key={g.id} active={state.activeGroup === g.id} onClick={() => setActiveGroup(g.id)}
                onRemove={() => requestDeleteGroup(g.id, g.name)} name={g.name} count={g.tickers.length} />
            ))}
            {activeGroups.length === 0 && <div className="text-xs opacity-40 italic px-3 py-2">No groups yet.</div>}
          </div>

          {/* Tickers in active group */}
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold tracking-widest uppercase opacity-50">Tickers</h2>
            <button onClick={() => setShowAddTicker(true)} className="opacity-50 hover:opacity-100 transition"><Plus size={14} /></button>
          </div>

          {showAddTicker && (
            <div className="mb-3 p-3 rounded-xl fade-in" style={{ background: "white", border: "1px solid #e5e5e5" }}>
              <input autoFocus value={newTicker} onChange={e => setNewTicker(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === "Enter" && addTicker()}
                placeholder="e.g. AAPL" className="w-full text-sm focus:outline-none mb-2 font-medium" />
              <div className="text-[10px] opacity-50 mb-1">Add to group:</div>
              <select value={newTickerGroup} onChange={e => setNewTickerGroup(e.target.value)}
                className="w-full text-xs py-1.5 px-2 rounded-md mb-2 focus:outline-none"
                style={{ background: "#f7f7f3", border: "1px solid #e5e5e5" }}>
                {activeGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <div className="flex gap-1.5">
                <button onClick={addTicker} className="flex-1 text-xs py-1.5 rounded-md text-white" style={{ background: "#1a1a1a" }}>Add</button>
                <button onClick={() => setShowAddTicker(false)} className="px-3 text-xs py-1.5 rounded-md" style={{ background: "#f0f0ec" }}>Cancel</button>
              </div>
            </div>
          )}

          <div className="space-y-1">
            {displayedTickers.map(tk => {
              const p   = quotes[tk] || { c: 0, d: 0, dp: 0 };
              const up  = (p.d || 0) >= 0;
              const isSel = state.selected === tk;
              const hasHigh = (newsByTicker[tk] || []).some(n => n.impact === "high");
              return (
                <div key={tk} onClick={() => setSelected(tk)}
                  className="group cursor-pointer flex items-center justify-between px-3 py-2.5 rounded-xl transition-all"
                  style={{ background: isSel ? "white" : "transparent", boxShadow: isSel ? "0 1px 3px rgba(0,0,0,0.04), 0 0 0 1px #e5e5e5" : "none" }}>
                  <div className="flex items-center gap-2 min-w-0">
                    {hasHigh && <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "#ef4444" }} />}
                    <div className="min-w-0">
                      <div className="font-semibold text-sm">{tk}</div>
                      <div className="text-[11px] opacity-50 truncate">{profiles[tk]?.name || (loadingTicker[tk] ? "Loading…" : "—")}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="text-right">
                      <div className="text-xs font-medium">{p.c ? `$${p.c.toFixed(2)}` : "—"}</div>
                      <div className="text-[11px]" style={{ color: up ? "#059669" : "#dc2626" }}>{p.c ? `${up ? "+" : ""}${(p.dp || 0).toFixed(2)}%` : ""}</div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); requestDeleteTicker(tk); }}
                      className="opacity-0 group-hover:opacity-40 hover:opacity-100 transition p-1 rounded hover:bg-red-50"
                      style={{ color: "#dc2626" }}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              );
            })}
            {displayedTickers.length === 0 && <div className="text-xs opacity-40 italic px-3 py-4">No tickers in this group yet.</div>}
          </div>

          {/* Cross-group note for custom tab */}
          {state.activeTab === "custom" && (
            <div className="mt-4 p-3 rounded-xl text-[11px] opacity-50 leading-relaxed" style={{ background: "#f7f7f3" }}>
              A ticker can belong to multiple Custom groups. Add it again in another group — it stays in both.
            </div>
          )}
        </aside>

        {/* ── MAIN ── */}
        <main className="col-span-9">

          {/* ── FEED VIEW ── */}
          {view === "feed" && (
            <>
              <section className="rounded-2xl p-8 mb-6" style={{ background: "white", boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 0 0 1px #ececec" }}>
                <div className="flex items-start justify-between mb-6">
                  <div>
                    <div className="text-xs tracking-widest uppercase opacity-50 mb-1">{profile.name || "—"}</div>
                    <h2 className="font-serif-h text-5xl font-semibold tracking-tight">{selected}</h2>
                    {profile.finnhubIndustry && <div className="text-xs opacity-50 mt-2">{profile.finnhubIndustry} · {profile.exchange}</div>}
                  </div>
                  <div className="text-right">
                    <div className="font-serif-h text-4xl font-semibold">{quote.c ? `$${quote.c.toFixed(2)}` : "—"}</div>
                    {quote.c > 0 && (
                      <div className="flex items-center gap-1 justify-end text-sm mt-1" style={{ color: isUp ? "#059669" : "#dc2626" }}>
                        {isUp ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                        <span className="font-medium">{isUp ? "+" : ""}{quote.d.toFixed(2)} ({isUp ? "+" : ""}{quote.dp.toFixed(2)}%)</span>
                      </div>
                    )}
                    {profile.weburl && (
                      <a href={profile.weburl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs opacity-40 hover:opacity-80 mt-2">
                        {profile.weburl.replace(/^https?:\/\//, '').replace(/\/$/, '')} <ExternalLink size={10} />
                      </a>
                    )}
                  </div>
                </div>
                <div className="rounded-xl p-4 mb-4" style={{ background: "#fafaf7", border: "1px solid #f0f0ec" }}>
                  <PriceChart symbol={selected} isUp={isUp} />
                </div>
                {quote.c > 0 && (
                  <div className="grid grid-cols-4 gap-3">
                    {[
                      { label: "Open",       val: `$${quote.o?.toFixed(2) ?? "—"}` },
                      { label: "High",       val: `$${quote.h?.toFixed(2) ?? "—"}` },
                      { label: "Low",        val: `$${quote.l?.toFixed(2) ?? "—"}` },
                      { label: "Prev Close", val: `$${quote.pc?.toFixed(2) ?? "—"}` },
                    ].map(s => (
                      <div key={s.label} className="rounded-lg px-3 py-2 text-center" style={{ background: "#fafaf7" }}>
                        <div className="text-[10px] tracking-widest uppercase opacity-40 mb-0.5">{s.label}</div>
                        <div className="text-sm font-semibold">{s.val}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                  <h3 className="font-serif-h text-2xl font-semibold">
                    {activeGroups.find(g => g.id === state.activeGroup)?.name || "Headlines"}
                  </h3>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setShowFilter(s => !s)}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium transition"
                      style={{
                        background: activeTags.length > 0 || showFilter ? "#1a1a1a" : "white",
                        color:      activeTags.length > 0 || showFilter ? "#fafaf7" : "#1a1a1a",
                        border:     "1px solid " + (activeTags.length > 0 || showFilter ? "#1a1a1a" : "#e5e5e5"),
                      }}>
                      <Sparkles size={12} /> AI Filter
                      {activeTags.length > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full ml-1" style={{ background: "#fafaf7", color: "#1a1a1a" }}>{activeTags.length}</span>
                      )}
                    </button>
                    <div className="text-xs opacity-50">{visibleNews.length} stories</div>
                  </div>
                </div>

                {showFilter && (
                  <div className="mb-4 p-4 rounded-xl fade-in" style={{ background: "white", border: "1px solid #ececec" }}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Filter size={12} className="opacity-50" />
                        <span className="text-xs font-semibold tracking-widest uppercase opacity-60">Filter by topic</span>
                        {taggingInProgress && <span className="text-[10px] opacity-50 flex items-center gap-1"><RefreshCw size={9} className="animate-spin" /> tagging…</span>}
                      </div>
                      {activeTags.length > 0 && <button onClick={() => setActiveTags([])} className="text-xs opacity-50 hover:opacity-100">Clear all</button>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {AVAILABLE_TAGS.map(tag => {
                        const active = activeTags.includes(tag);
                        const style  = TAG_STYLES[tag];
                        return (
                          <button key={tag} onClick={() => toggleTag(tag)}
                            className="text-xs px-3 py-1.5 rounded-full font-medium transition-all"
                            style={{ background: active ? style.color : style.bg, color: active ? "white" : style.color, border: "1px solid " + (active ? style.color : "transparent") }}>
                            {tag}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-3 text-[11px] opacity-50">Showing news matching ANY selected tag. Tags are AI-generated and cached.</div>
                  </div>
                )}

                <div className="space-y-3">
                  {visibleNews.map(n => (
                    <NewsCard key={n._key} news={n} tags={tagsByNewsKey[n._key] || []}
                      pinned={!!state.pinned?.[String(n.id || n.url)]}
                      onPin={() => togglePin(n.ticker, n)} onSelect={() => setSelected(n.ticker)} onTagClick={toggleTag} />
                  ))}
                  {visibleNews.length === 0 && (
                    <div className="text-center py-12 opacity-40 italic text-sm">
                      {activeTags.length > 0 ? "No headlines match the selected tags." : allTickers.some(tk => loadingTicker[tk]) ? "Loading news…" : "No headlines yet."}
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          {/* ── PINNED VIEW ── */}
          {view === "pinned" && (
            <section>
              <div className="mb-6">
                <h2 className="font-serif-h text-3xl font-semibold mb-1">Pinned & tracked</h2>
                <p className="text-sm opacity-60">Stories you've saved. Items older than {REMINDER_DAYS} days are flagged for review.</p>
              </div>
              {pinnedItems.length === 0 ? (
                <div className="rounded-2xl p-12 text-center" style={{ background: "white", border: "1px solid #ececec" }}>
                  <Bookmark size={32} className="mx-auto opacity-20 mb-3" />
                  <div className="text-sm opacity-60">No pinned stories yet.</div>
                  <div className="text-xs opacity-40 mt-1">Click the star on any headline to save it here.</div>
                </div>
              ) : (
                <div className="space-y-3">
                  {pinnedItems.map(p => {
                    const days = daysSince(p.pinnedAt);
                    const needsReview = days >= REMINDER_DAYS;
                    return (
                      <div key={p.key} className="rounded-xl p-5 fade-in"
                        style={{ background: "white", border: needsReview ? "1px solid #fbbf24" : "1px solid #ececec", boxShadow: needsReview ? "0 0 0 3px #fef3c7" : "none" }}>
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <button onClick={() => { setSelected(p.ticker); setView("feed"); }}
                                className="text-xs font-bold px-2 py-0.5 rounded-md" style={{ background: "#f0f0ec" }}>${p.ticker}</button>
                              <span className="text-[11px] opacity-50">{p.news.source}</span>
                              <span className="text-[11px] opacity-30">·</span>
                              <span className="text-[11px] opacity-50">{formatTimestamp(p.news.datetime)}</span>
                              <span className="text-[11px] opacity-30">·</span>
                              <span className="text-[11px] opacity-50">pinned {days === 0 ? "today" : `${days}d ago`}</span>
                              {needsReview && (
                                <span className="ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "#fef3c7", color: "#92400e" }}>
                                  <Bell size={9} /> Review?
                                </span>
                              )}
                            </div>
                            <a href={p.news.url} target="_blank" rel="noreferrer" className="font-serif-h text-lg font-semibold leading-snug mb-1 hover:underline block">{p.news.headline}</a>
                            <p className="text-sm opacity-60 leading-relaxed">{p.news.summary}</p>
                          </div>
                          <button onClick={() => togglePin(p.ticker, p.news)} className="flex-shrink-0 p-1">
                            <Star size={16} fill="#fbbf24" stroke="#fbbf24" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* ── WATCHING VIEW ── */}
          {view === "watching" && (
            <section>
              <div className="mb-6">
                <h2 className="font-serif-h text-3xl font-semibold mb-1">Watching</h2>
                <p className="text-sm opacity-60">News alerts triggered by your keywords. Matches are saved automatically.</p>
              </div>

              {/* Keyword manager */}
              <div className="rounded-2xl p-6 mb-6" style={{ background: "white", border: "1px solid #ececec" }}>
                <div className="flex items-center justify-between mb-4">
                  <div className="text-sm font-semibold">Alert keywords</div>
                  <div className="text-xs opacity-50">{state.watchKeywords?.length || 0} active</div>
                </div>
                <div className="flex gap-2 mb-4">
                  <input value={newKeyword} onChange={e => setNewKeyword(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && addKeyword()}
                    placeholder="e.g. layoffs, FDA, earnings beat, acquisition…"
                    className="flex-1 text-sm px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition"
                    style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                  <button onClick={addKeyword} className="px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ background: "#1a1a1a" }}>
                    Add
                  </button>
                </div>
                {state.watchKeywords?.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {state.watchKeywords.map(kw => (
                      <div key={kw.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                        style={{ background: "#f0f0ec", color: "#1a1a1a" }}>
                        <Eye size={11} className="opacity-50" />
                        {kw.keyword}
                        <button onClick={() => removeKeyword(kw.id)} className="opacity-50 hover:opacity-100 ml-0.5"><X size={11} /></button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs opacity-40 italic">No keywords yet. Add one above and any matching news from your watchlist will appear here automatically.</p>
                )}
              </div>

              {/* Matches */}
              {watchItems.length === 0 ? (
                <div className="rounded-2xl p-12 text-center" style={{ background: "white", border: "1px solid #ececec" }}>
                  <Eye size={32} className="mx-auto opacity-20 mb-3" />
                  <div className="text-sm opacity-60">No matches yet.</div>
                  <div className="text-xs opacity-40 mt-1">Add keywords above. When news from your watchlist matches, it'll appear here.</div>
                </div>
              ) : (
                <div className="space-y-3">
                  {watchItems.map((m, idx) => {
                    const matchId = Object.keys(state.watchMatches || {}).find(k => state.watchMatches[k] === m)
                      || idx;
                    return (
                      <div key={matchId} className="rounded-xl p-5 fade-in"
                        style={{ background: "white", border: "1px solid #d1fae5", boxShadow: "0 0 0 3px #ecfdf5" }}>
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1"
                                style={{ background: "#d1fae5", color: "#065f46" }}>
                                <Eye size={9} /> {m.keyword}
                              </span>
                              <button onClick={() => { setSelected(m.ticker); setView("feed"); }}
                                className="text-xs font-bold px-2 py-0.5 rounded-md" style={{ background: "#f0f0ec" }}>${m.ticker}</button>
                              <span className="text-[11px] opacity-50">{m.news.source}</span>
                              <span className="text-[11px] opacity-30">·</span>
                              <span className="text-[11px] opacity-50">{formatTimestamp(m.news.datetime)}</span>
                            </div>
                            <a href={m.news.url} target="_blank" rel="noreferrer"
                              className="font-serif-h text-lg font-semibold leading-snug mb-1 hover:underline block">
                              {m.news.headline}
                            </a>
                            {m.news.summary && <p className="text-sm opacity-60 leading-relaxed">{m.news.summary}</p>}
                          </div>
                          <button onClick={() => removeWatchMatch(matchId)} className="flex-shrink-0 p-1.5 opacity-40 hover:opacity-100 transition hover:bg-gray-100 rounded-full">
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </main>
      </div>

      <footer className="border-t mt-12 py-6" style={{ borderColor: "#ececec" }}>
        <div className="max-w-7xl mx-auto px-8 text-xs opacity-40 flex items-center justify-between flex-wrap gap-2">
          <span>Ticker · personal market intelligence · not investment advice</span>
          <span>Data: Finnhub + Alpha Vantage · {cloudStatus === "synced" ? "Synced" : cloudStatus === "offline" ? "Local only" : "Connecting…"}</span>
        </div>
      </footer>
    </div>
  );
}

