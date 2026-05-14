import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  TrendingUp, TrendingDown, Plus, X, Star, Bookmark, Search, FolderPlus,
  ChevronRight, Bell, RefreshCw, ExternalLink, Cloud, CloudOff, Copy, Check,
  Sparkles, Filter
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer
} from "recharts";
import { getQuote, getProfile, getNews, getCandles, classifyImpact, timeAgo } from "./lib/finnhub";
import { supabase, getIdentity, setIdentity, loadState, saveState } from "./lib/supabase";
import { tagNews, AVAILABLE_TAGS, TAG_STYLES } from "./lib/tagger";

const DEFAULT_STATE = {
  groups: [
    { id: "g1", name: "AI & Semis",    tickers: ["NVDA", "AMD"] },
    { id: "g2", name: "Mega-cap Tech", tickers: ["AAPL", "MSFT", "GOOGL"] },
    { id: "g3", name: "EV & Mobility", tickers: ["TSLA"] },
  ],
  activeGroup: "all",
  selected: "NVDA",
  pinned: {},
};

const REMINDER_DAYS = 3;

// ---- Custom Recharts tooltip ----
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value;
  return (
    <div className="px-3 py-2 rounded-lg text-xs shadow-lg" style={{ background: "white", border: "1px solid #ececec" }}>
      <div className="opacity-50 mb-0.5">{label}</div>
      <div className="font-semibold text-sm">${v?.toFixed(2)}</div>
    </div>
  );
}

// ---- Price chart component ----
function PriceChart({ symbol, isUp }) {
  const [candles, setCandles]   = useState([]);
  const [range, setRange]       = useState(6);     // months: 1 | 3 | 6
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(false);

  useEffect(() => {
    if (!symbol) return;
    setLoading(true);
    setError(false);
    getCandles(symbol, range)
      .then(data => { setCandles(data); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }, [symbol, range]);

  const color    = isUp ? "#059669" : "#dc2626";
  const fillId   = `fill-${symbol}`;
  const minClose = useMemo(() => Math.min(...candles.map(c => c.close)) * 0.995, [candles]);
  const maxClose = useMemo(() => Math.max(...candles.map(c => c.close)) * 1.005, [candles]);

  // Show every ~15th label so x-axis isn't crowded
  const tickInterval = Math.max(1, Math.floor(candles.length / 6));

  if (loading) {
    return (
      <div className="h-36 flex items-center justify-center opacity-30 text-xs">
        Loading chart…
      </div>
    );
  }

  if (error || candles.length === 0) {
    return (
      <div className="h-36 flex items-center justify-center opacity-30 text-xs">
        Chart unavailable
      </div>
    );
  }

  return (
    <div>
      {/* Range toggle */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] tracking-widest uppercase opacity-40">Price history</span>
        <div className="flex items-center gap-1">
          {[1, 3, 6].map(m => (
            <button
              key={m}
              onClick={() => setRange(m)}
              className="text-[11px] px-2 py-0.5 rounded-full transition-all font-medium"
              style={{
                background: range === m ? "#1a1a1a" : "#f0f0ec",
                color:      range === m ? "white"   : "#525252",
              }}
            >
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
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: "#a3a3a3" }}
            tickLine={false}
            axisLine={false}
            interval={tickInterval}
          />
          <YAxis
            domain={[minClose, maxClose]}
            tick={{ fontSize: 10, fill: "#a3a3a3" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => `$${v.toFixed(0)}`}
            width={48}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#e5e5e5", strokeWidth: 1 }} />
          <Area
            type="monotone"
            dataKey="close"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${fillId})`}
            dot={false}
            activeDot={{ r: 3, fill: color, strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---- Main app ----
export default function App() {
  const [state, setState]     = useState(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [cloudStatus, setCloudStatus] = useState("connecting");

  const [quotes, setQuotes]     = useState({});
  const [profiles, setProfiles] = useState({});
  const [newsByTicker, setNewsByTicker] = useState({});
  const [loadingTicker, setLoadingTicker] = useState({});

  const [tagsByNewsKey, setTagsByNewsKey] = useState({});
  const [activeTags, setActiveTags] = useState([]);
  const [showFilter, setShowFilter] = useState(false);
  const [taggingInProgress, setTaggingInProgress] = useState(false);

  const [showAddTicker, setShowAddTicker]   = useState(false);
  const [showAddGroup, setShowAddGroup]     = useState(false);
  const [showSync, setShowSync]             = useState(false);
  const [newTicker, setNewTicker]           = useState("");
  const [newTickerGroup, setNewTickerGroup] = useState("g1");
  const [newGroupName, setNewGroupName]     = useState("");
  const [search, setSearch]   = useState("");
  const [view, setView]       = useState("feed");

  // Hydrate
  useEffect(() => {
    (async () => {
      if (!supabase) { setCloudStatus("offline"); setHydrated(true); return; }
      try {
        const saved = await loadState();
        if (saved) setState(saved);
        setCloudStatus("synced");
      } catch { setCloudStatus("offline"); }
      setHydrated(true);
    })();
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveState(state);
  }, [state, hydrated]);

  const allTickers = useMemo(() => {
    const s = new Set();
    state.groups.forEach(g => g.tickers.forEach(t => s.add(t)));
    return [...s];
  }, [state.groups]);

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
      setNewsByTicker(prev => ({
        ...prev,
        [tk]: (n || []).slice(0, 20).map(item => ({
          ...item,
          impact: classifyImpact(item.headline),
          tAgo:   timeAgo(item.datetime),
        }))
      }));
    } finally {
      setLoadingTicker(prev => ({ ...prev, [tk]: false }));
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    allTickers.forEach(tk => {
      if (!quotes[tk] && !loadingTicker[tk]) loadTicker(tk);
    });
  }, [hydrated, allTickers, quotes, loadingTicker, loadTicker]);

  useEffect(() => {
    if (!hydrated) return;
    const id = setInterval(() => {
      allTickers.forEach(tk =>
        getQuote(tk).then(q => setQuotes(p => ({ ...p, [tk]: q }))).catch(() => {})
      );
    }, 60_000);
    return () => clearInterval(id);
  }, [hydrated, allTickers]);

  // Auto-tag new headlines
  useEffect(() => {
    if (!hydrated) return;
    const allItems = Object.entries(newsByTicker).flatMap(([tk, arr]) =>
      arr.map(n => ({ key: `${tk}_${n.id || n.url}`, headline: n.headline }))
    );
    const untagged = allItems.filter(it => !tagsByNewsKey[it.key]);
    if (untagged.length === 0) return;
    setTaggingInProgress(true);
    tagNews(untagged)
      .then(tags => setTagsByNewsKey(prev => ({ ...prev, ...tags })))
      .finally(() => setTaggingInProgress(false));
  }, [hydrated, newsByTicker]); // eslint-disable-line

  const displayedTickers = useMemo(() => {
    if (state.activeGroup === "all") return allTickers;
    const g = state.groups.find(g => g.id === state.activeGroup);
    return g ? g.tickers : [];
  }, [state.activeGroup, state.groups, allTickers]);

  const visibleNews = useMemo(() => {
    let items = displayedTickers.flatMap(tk =>
      (newsByTicker[tk] || []).map(n => ({
        ...n, ticker: tk, _key: `${tk}_${n.id || n.url}`,
      }))
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

  const pinnedItems = useMemo(
    () => Object.values(state.pinned).sort((a, b) => b.pinnedAt - a.pinnedAt),
    [state.pinned]
  );
  const remindersNeeded = pinnedItems.filter(
    p => (Date.now() - p.pinnedAt) / 86400000 >= REMINDER_DAYS
  );

  const updateState = fn => setState(prev => fn(prev));

  const togglePin = (ticker, news) => updateState(s => {
    const next = { ...s.pinned };
    const key  = String(news.id || news.url);
    if (next[key]) delete next[key];
    else next[key] = { ticker, news, pinnedAt: Date.now(), key };
    return { ...s, pinned: next };
  });

  const addTicker = async () => {
    const t = newTicker.trim().toUpperCase();
    if (!t) return;
    updateState(s => ({
      ...s,
      groups: s.groups.map(g =>
        g.id === newTickerGroup && !g.tickers.includes(t)
          ? { ...g, tickers: [...g.tickers, t] } : g
      ),
      selected: t,
    }));
    setNewTicker(""); setShowAddTicker(false);
    loadTicker(t);
  };

  const addGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    const id = "g" + Date.now();
    updateState(s => ({ ...s, groups: [...s.groups, { id, name, tickers: [] }], activeGroup: id }));
    setNewGroupName(""); setShowAddGroup(false);
  };

  const removeTicker  = tk  => updateState(s => ({ ...s, groups: s.groups.map(g => ({ ...g, tickers: g.tickers.filter(t => t !== tk) })) }));
  const removeGroup   = gid => updateState(s => ({ ...s, groups: s.groups.filter(g => g.id !== gid), activeGroup: s.activeGroup === gid ? "all" : s.activeGroup }));
  const setSelected   = tk  => updateState(s => ({ ...s, selected: tk }));
  const setActiveGroup = g  => updateState(s => ({ ...s, activeGroup: g }));
  const refreshAll    = ()  => allTickers.forEach(loadTicker);
  const toggleTag     = tag => setActiveTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);

  const selected  = state.selected;
  const quote     = quotes[selected]  || { c: 0, d: 0, dp: 0 };
  const profile   = profiles[selected] || {};
  const isUp      = (quote.d || 0) >= 0;
  const daysSince = ts => Math.floor((Date.now() - ts) / 86400000);

  return (
    <div className="min-h-screen w-full">
      {/* HEADER */}
      <header className="border-b sticky top-0 z-20 backdrop-blur-md" style={{ borderColor: "#ececec", background: "rgba(250,250,247,0.85)" }}>
        <div className="max-w-7xl mx-auto px-8 py-4 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-8">
            <div>
              <h1 className="font-serif-h text-2xl font-semibold tracking-tight">Ticker<span style={{ color: "#c2410c" }}>.</span></h1>
              <div className="text-[10px] tracking-[0.25em] uppercase opacity-50 mt-0.5">Your market, distilled</div>
            </div>
            <nav className="flex items-center gap-1">
              <button onClick={() => setView("feed")} className="px-3 py-1.5 text-sm rounded-full transition-all" style={{ background: view === "feed" ? "#1a1a1a" : "transparent", color: view === "feed" ? "#fafaf7" : "#1a1a1a" }}>Feed</button>
              <button onClick={() => setView("pinned")} className="px-3 py-1.5 text-sm rounded-full transition-all flex items-center gap-1.5" style={{ background: view === "pinned" ? "#1a1a1a" : "transparent", color: view === "pinned" ? "#fafaf7" : "#1a1a1a" }}>
                <Bookmark size={13} />
                Pinned
                {pinnedItems.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: view === "pinned" ? "#fafaf7" : "#1a1a1a", color: view === "pinned" ? "#1a1a1a" : "#fafaf7" }}>{pinnedItems.length}</span>
                )}
              </button>
            </nav>
          </div>
          <div className="flex items-center gap-2">
            {remindersNeeded.length > 0 && (
              <button onClick={() => setView("pinned")} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full hover:opacity-80" style={{ background: "#fef3c7", color: "#92400e" }}>
                <Bell size={12} />
                {remindersNeeded.length} pinned need review
              </button>
            )}
            <button onClick={refreshAll} title="Refresh all" className="p-1.5 rounded-full hover:bg-gray-100 transition opacity-60 hover:opacity-100"><RefreshCw size={14} /></button>
            <button onClick={() => setShowSync(true)} title="Sync" className="p-1.5 rounded-full hover:bg-gray-100 transition" style={{ color: cloudStatus === "synced" ? "#059669" : cloudStatus === "offline" ? "#dc2626" : "#a3a3a3" }}>
              {cloudStatus === "offline" ? <CloudOff size={14} /> : <Cloud size={14} />}
            </button>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-40" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search news" className="pl-9 pr-3 py-1.5 text-sm rounded-full border focus:outline-none focus:border-gray-900 transition" style={{ borderColor: "#e5e5e5", background: "white", width: 200 }} />
            </div>
          </div>
        </div>
      </header>

      {showSync && <SyncModal onClose={() => setShowSync(false)} />}

      <div className="max-w-7xl mx-auto px-8 py-8 grid grid-cols-12 gap-8">
        {/* SIDEBAR */}
        <aside className="col-span-3">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold tracking-widest uppercase opacity-50">Groups</h2>
            <button onClick={() => setShowAddGroup(true)} className="opacity-50 hover:opacity-100 transition"><FolderPlus size={14} /></button>
          </div>
          {showAddGroup && (
            <div className="mb-3 p-3 rounded-xl fade-in" style={{ background: "white", border: "1px solid #e5e5e5" }}>
              <input autoFocus value={newGroupName} onChange={e => setNewGroupName(e.target.value)} onKeyDown={e => e.key === "Enter" && addGroup()} placeholder="Group name…" className="w-full text-sm focus:outline-none mb-2" />
              <div className="flex gap-1.5">
                <button onClick={addGroup} className="flex-1 text-xs py-1.5 rounded-md text-white" style={{ background: "#1a1a1a" }}>Create</button>
                <button onClick={() => setShowAddGroup(false)} className="px-3 text-xs py-1.5 rounded-md" style={{ background: "#f0f0ec" }}>Cancel</button>
              </div>
            </div>
          )}
          <div className="space-y-0.5 mb-6">
            <GroupRow active={state.activeGroup === "all"} onClick={() => setActiveGroup("all")} name="All tickers" count={allTickers.length} />
            {state.groups.map(g => (
              <GroupRow key={g.id} active={state.activeGroup === g.id} onClick={() => setActiveGroup(g.id)} onRemove={() => removeGroup(g.id)} name={g.name} count={g.tickers.length} />
            ))}
          </div>

          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold tracking-widest uppercase opacity-50">Tickers</h2>
            <button onClick={() => setShowAddTicker(true)} className="opacity-50 hover:opacity-100 transition"><Plus size={14} /></button>
          </div>
          {showAddTicker && (
            <div className="mb-3 p-3 rounded-xl fade-in" style={{ background: "white", border: "1px solid #e5e5e5" }}>
              <input autoFocus value={newTicker} onChange={e => setNewTicker(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && addTicker()} placeholder="e.g. AAPL" className="w-full text-sm focus:outline-none mb-2 font-medium" />
              <select value={newTickerGroup} onChange={e => setNewTickerGroup(e.target.value)} className="w-full text-xs py-1.5 px-2 rounded-md mb-2 focus:outline-none" style={{ background: "#f7f7f3", border: "1px solid #e5e5e5" }}>
                {state.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <div className="flex gap-1.5">
                <button onClick={addTicker} className="flex-1 text-xs py-1.5 rounded-md text-white" style={{ background: "#1a1a1a" }}>Add</button>
                <button onClick={() => setShowAddTicker(false)} className="px-3 text-xs py-1.5 rounded-md" style={{ background: "#f0f0ec" }}>Cancel</button>
              </div>
            </div>
          )}
          <div className="space-y-1">
            {displayedTickers.map(tk => {
              const p = quotes[tk] || { c: 0, d: 0, dp: 0 };
              const up = (p.d || 0) >= 0;
              const isSel = state.selected === tk;
              const hasHigh = (newsByTicker[tk] || []).some(n => n.impact === "high");
              return (
                <div key={tk} onClick={() => setSelected(tk)} className="group cursor-pointer flex items-center justify-between px-3 py-2.5 rounded-xl transition-all" style={{ background: isSel ? "white" : "transparent", boxShadow: isSel ? "0 1px 3px rgba(0,0,0,0.04), 0 0 0 1px #e5e5e5" : "none" }}>
                  <div className="flex items-center gap-2 min-w-0">
                    {hasHigh && <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "#ef4444" }} />}
                    <div className="min-w-0">
                      <div className="font-semibold text-sm">{tk}</div>
                      <div className="text-[11px] opacity-50 truncate">{profiles[tk]?.name || (loadingTicker[tk] ? "Loading…" : "—")}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-right">
                      <div className="text-xs font-medium">{p.c ? `$${p.c.toFixed(2)}` : "—"}</div>
                      <div className="text-[11px]" style={{ color: up ? "#059669" : "#dc2626" }}>{p.c ? `${up ? "+" : ""}${(p.dp || 0).toFixed(2)}%` : ""}</div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); removeTicker(tk); }} className="opacity-0 group-hover:opacity-40 hover:opacity-100 transition"><X size={12} /></button>
                  </div>
                </div>
              );
            })}
            {displayedTickers.length === 0 && <div className="text-xs opacity-40 italic px-3 py-4">No tickers in this group yet.</div>}
          </div>
        </aside>

        {/* MAIN */}
        <main className="col-span-9">
          {view === "feed" ? (
            <>
              {/* TICKER HERO CARD */}
              <section className="rounded-2xl p-8 mb-6" style={{ background: "white", boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 0 0 1px #ececec" }}>
                {/* Top row: name + price */}
                <div className="flex items-start justify-between mb-6">
                  <div>
                    <div className="text-xs tracking-widest uppercase opacity-50 mb-1">{profile.name || "—"}</div>
                    <h2 className="font-serif-h text-5xl font-semibold tracking-tight">{selected}</h2>
                    {profile.finnhubIndustry && (
                      <div className="text-xs opacity-50 mt-2">{profile.finnhubIndustry} · {profile.exchange}</div>
                    )}
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
                        {profile.weburl.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                        <ExternalLink size={10} />
                      </a>
                    )}
                  </div>
                </div>

                {/* PRICE CHART */}
                <div className="rounded-xl p-4 mb-4" style={{ background: "#fafaf7", border: "1px solid #f0f0ec" }}>
                  <PriceChart symbol={selected} isUp={isUp} />
                </div>

                {/* OHLV mini stats row */}
                {quote.c > 0 && (
                  <div className="grid grid-cols-4 gap-3">
                    {[
                      { label: "Open",    val: `$${quote.o?.toFixed(2) ?? "—"}` },
                      { label: "High",    val: `$${quote.h?.toFixed(2) ?? "—"}` },
                      { label: "Low",     val: `$${quote.l?.toFixed(2) ?? "—"}` },
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

              {/* NEWS FEED */}
              <section>
                <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                  <h3 className="font-serif-h text-2xl font-semibold">
                    {state.activeGroup === "all" ? "All headlines" : state.groups.find(g => g.id === state.activeGroup)?.name}
                  </h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowFilter(s => !s)}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium transition"
                      style={{
                        background: activeTags.length > 0 || showFilter ? "#1a1a1a" : "white",
                        color:      activeTags.length > 0 || showFilter ? "#fafaf7" : "#1a1a1a",
                        border:     "1px solid " + (activeTags.length > 0 || showFilter ? "#1a1a1a" : "#e5e5e5"),
                      }}
                    >
                      <Sparkles size={12} />
                      AI Filter
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
                        {taggingInProgress && (
                          <span className="text-[10px] opacity-50 flex items-center gap-1">
                            <RefreshCw size={9} className="animate-spin" /> tagging…
                          </span>
                        )}
                      </div>
                      {activeTags.length > 0 && (
                        <button onClick={() => setActiveTags([])} className="text-xs opacity-50 hover:opacity-100">Clear all</button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {AVAILABLE_TAGS.map(tag => {
                        const active = activeTags.includes(tag);
                        const style  = TAG_STYLES[tag];
                        return (
                          <button
                            key={tag}
                            onClick={() => toggleTag(tag)}
                            className="text-xs px-3 py-1.5 rounded-full font-medium transition-all"
                            style={{
                              background: active ? style.color : style.bg,
                              color:      active ? "white"      : style.color,
                              border:     "1px solid " + (active ? style.color : "transparent"),
                            }}
                          >
                            {tag}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-3 text-[11px] opacity-50">
                      Showing news matching ANY selected tag. Tags are AI-generated and cached.
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  {visibleNews.map(n => (
                    <NewsCard
                      key={n._key}
                      news={n}
                      tags={tagsByNewsKey[n._key] || []}
                      pinned={!!state.pinned[String(n.id || n.url)]}
                      onPin={() => togglePin(n.ticker, n)}
                      onSelect={() => setSelected(n.ticker)}
                      onTagClick={toggleTag}
                    />
                  ))}
                  {visibleNews.length === 0 && (
                    <div className="text-center py-12 opacity-40 italic text-sm">
                      {activeTags.length > 0
                        ? "No headlines match the selected tags."
                        : allTickers.some(tk => loadingTicker[tk])
                          ? "Loading news…"
                          : "No headlines yet. Add a ticker to get started."}
                    </div>
                  )}
                </div>
              </section>
            </>
          ) : (
            /* PINNED VIEW */
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
                      <div key={p.key} className="rounded-xl p-5 fade-in" style={{ background: "white", border: needsReview ? "1px solid #fbbf24" : "1px solid #ececec", boxShadow: needsReview ? "0 0 0 3px #fef3c7" : "none" }}>
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <button onClick={() => { setSelected(p.ticker); setView("feed"); }} className="text-xs font-bold px-2 py-0.5 rounded-md" style={{ background: "#f0f0ec" }}>${p.ticker}</button>
                              <span className="text-[11px] opacity-50">{p.news.source}</span>
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
        </main>
      </div>

      <footer className="border-t mt-12 py-6" style={{ borderColor: "#ececec" }}>
        <div className="max-w-7xl mx-auto px-8 text-xs opacity-40 flex items-center justify-between flex-wrap gap-2">
          <span>Ticker · personal market intelligence · not investment advice</span>
          <span>Data: Finnhub · {cloudStatus === "synced" ? "Synced" : cloudStatus === "offline" ? "Local only" : "Connecting…"}</span>
        </div>
      </footer>
    </div>
  );
}

function GroupRow({ active, onClick, onRemove, name, count }) {
  return (
    <div onClick={onClick} className="group cursor-pointer flex items-center justify-between px-3 py-2 rounded-lg transition-all text-sm" style={{ background: active ? "#1a1a1a" : "transparent", color: active ? "#fafaf7" : "#1a1a1a" }}>
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

function NewsCard({ news, tags, pinned, onPin, onSelect, onTagClick }) {
  return (
    <article className="rounded-xl p-5 group" style={{ background: "white", border: "1px solid #ececec" }}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <button onClick={onSelect} className="text-xs font-bold px-2 py-0.5 rounded-md hover:bg-gray-200" style={{ background: "#f0f0ec" }}>${news.ticker}</button>
            <span className="text-[11px] opacity-50">{news.source}</span>
            <span className="text-[11px] opacity-30">·</span>
            <span className="text-[11px] opacity-50">{news.tAgo} ago</span>
          </div>
          <a href={news.url} target="_blank" rel="noreferrer" className="font-serif-h text-lg font-semibold leading-snug mb-1.5 hover:underline block">{news.headline}</a>
          {news.summary && <p className="text-sm opacity-60 leading-relaxed line-clamp-2 mb-2">{news.summary}</p>}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {tags.map(tag => {
                const style = TAG_STYLES[tag] || TAG_STYLES.Other;
                return (
                  <button
                    key={tag}
                    onClick={() => onTagClick?.(tag)}
                    className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider hover:opacity-80 transition"
                    style={{ background: style.bg, color: style.color }}
                  >
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
  const [id]  = useState(getIdentity());
  const [draft, setDraft] = useState(id);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const apply = () => {
    if (!draft.trim()) return;
    setIdentity(draft.trim());
    window.location.reload();
  };

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

