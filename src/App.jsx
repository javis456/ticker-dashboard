import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  TrendingUp, TrendingDown, Plus, X, Star, Bookmark, Search, FolderPlus,
  ChevronRight, ChevronDown, Bell, RefreshCw, ExternalLink, Cloud, CloudOff,
  Copy, Check, Sparkles, Filter, Eye, Trash2, AlertCircle, Tag, Layers,
  CheckCheck, FileText, Calendar, Target, TrendingUpIcon, Zap, Clock
} from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { getQuote, getProfile, getNews, getCandles, classifyImpact, timeAgo } from "./lib/finnhub";
import { supabase, getIdentity, setIdentity, loadState, saveState } from "./lib/supabase";
import { tagNews, AVAILABLE_TAGS, TAG_STYLES } from "./lib/tagger";
import { loadSummaries, saveSummary, deleteSummary, generateSummary } from "./lib/summaries";

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
  activeTab:   "sector",
  activeGroup: "s1",
  pinned:      {},
  watchCards:  [],
};
const REMINDER_DAYS = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatTimestamp(unixSeconds) {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  const isToday = d.toDateString() === new Date().toDateString();
  const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return isToday ? timeStr : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " + timeStr;
}
function timeSinceText(ms) {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60)       return "just now";
  if (diff < 3600)     return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)    return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)}w ago`;
  return `${Math.floor(diff / 86400 / 30)}mo ago`;
}
function matchesKeyword(keyword, news) {
  const kw = keyword.toLowerCase();
  return ((news.headline || "") + " " + (news.summary || "")).toLowerCase().includes(kw);
}

// Period helpers for Summarize
const PERIOD_OPTIONS = [
  { id: "1d", label: "1 day",     days: 1 },
  { id: "1w", label: "1 week",    days: 7 },
  { id: "1m", label: "1 month",   days: 30 },
  { id: "1q", label: "1 quarter", days: 90 },
  { id: "custom", label: "Custom", days: null },
];

function getPeriodDates(periodId, customFrom, customTo) {
  if (periodId === "custom") {
    return { from: customFrom, to: customTo };
  }
  const opt = PERIOD_OPTIONS.find(p => p.id === periodId);
  const days = opt?.days || 7;
  const to = new Date();
  const from = new Date(Date.now() - days * 86400000);
  return {
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
  };
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
  const [range, setRange] = useState(6);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!symbol) return;
    setLoading(true);
    getCandles(symbol, range).then(setCandles).catch(() => setCandles([])).finally(() => setLoading(false));
  }, [symbol, range]);
  const color = isUp ? "#059669" : "#dc2626";
  const fillId = `fill-${symbol}`;
  const minC = useMemo(() => candles.length ? Math.min(...candles.map(c => c.close)) * 0.995 : 0, [candles]);
  const maxC = useMemo(() => candles.length ? Math.max(...candles.map(c => c.close)) * 1.005 : 0, [candles]);
  const tickInterval = Math.max(1, Math.floor(candles.length / 6));
  if (loading) return <div className="h-36 flex items-center justify-center opacity-30 text-xs">Loading chart…</div>;
  if (!candles.length) return <div className="h-36 flex items-center justify-center opacity-30 text-xs">Chart unavailable</div>;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] tracking-widest uppercase opacity-40">Price history</span>
        <div className="flex items-center gap-1">
          {[1, 3, 6].map(m => (
            <button key={m} onClick={() => setRange(m)} className="text-[11px] px-2 py-0.5 rounded-full transition-all font-medium" style={{ background: range === m ? "#1a1a1a" : "#f0f0ec", color: range === m ? "white" : "#525252" }}>{m}M</button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={candles} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.15} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
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
            <span className="text-[11px] opacity-30">·</span>
            <span className="text-[11px] opacity-50">{news.tAgo} ago</span>
          </div>
          <a href={news.url} target="_blank" rel="noreferrer" className="font-serif-h text-lg font-semibold leading-snug mb-1.5 hover:underline block">{news.headline}</a>
          {news.summary && <p className="text-sm opacity-60 leading-relaxed line-clamp-2 mb-2">{news.summary}</p>}
          {tags?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {tags.map(tag => {
                const style = TAG_STYLES[tag] || TAG_STYLES.Other;
                return (
                  <button key={tag} onClick={() => onTagClick?.(tag)} className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider hover:opacity-80 transition" style={{ background: style.bg, color: style.color }}>
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

function WatchingCard({ card, onToggleOpen, onDelete, onMarkRead, onMarkAllRead, onDismissMatch }) {
  const unreadCount = card.matches.filter(m => !m.isRead).length;
  return (
    <div className="rounded-2xl fade-in overflow-hidden" style={{ background: "white", border: unreadCount > 0 ? "1px solid #6ee7b7" : "1px solid #ececec", boxShadow: unreadCount > 0 ? "0 0 0 3px #ecfdf5" : "none" }}>
      <div className="p-5 cursor-pointer" onClick={onToggleOpen}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold px-2 py-0.5 rounded-md" style={{ background: "#f0f0ec" }}>${card.ticker}</span>
            <span className="text-[11px] opacity-40">+</span>
            <span className="text-xs font-medium px-2 py-0.5 rounded-md flex items-center gap-1" style={{ background: "#f0f0ec", color: "#1a1a1a" }}>
              <Eye size={10} className="opacity-50" /> {card.keyword}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <div className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-bold" style={{ background: "#059669", color: "white" }}>
                <Bell size={10} /> {unreadCount} new
              </div>
            )}
            <button onClick={e => { e.stopPropagation(); onDelete(); }} className="p-1.5 rounded-full opacity-40 hover:opacity-100 hover:bg-red-50 transition" style={{ color: "#dc2626" }}>
              <Trash2 size={13} />
            </button>
            <button onClick={onToggleOpen} className="p-1.5 rounded-full opacity-40 hover:opacity-100 hover:bg-gray-100 transition">
              {card.isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] opacity-50">
          <span>Created {timeSinceText(card.createdAt)}</span>
          <span>·</span>
          <span>{card.matches.length === 0 ? "No matches yet" : `${card.matches.length} match${card.matches.length === 1 ? "" : "es"} total`}</span>
        </div>
      </div>
      {card.isOpen && (
        <div className="border-t" style={{ borderColor: "#f0f0ec" }}>
          {card.matches.length === 0 ? (
            <div className="px-5 py-6 text-center text-xs opacity-40 italic">
              Watching for new ${card.ticker} headlines mentioning "{card.keyword}"…
            </div>
          ) : (
            <>
              {unreadCount > 0 && (
                <div className="px-5 py-2.5 flex items-center justify-end" style={{ background: "#fafaf7", borderBottom: "1px solid #f0f0ec" }}>
                  <button onClick={onMarkAllRead} className="text-[11px] font-medium flex items-center gap-1 opacity-60 hover:opacity-100 transition">
                    <CheckCheck size={11} /> Mark all read
                  </button>
                </div>
              )}
              <div className="divide-y" style={{ borderColor: "#f0f0ec" }}>
                {card.matches.sort((a, b) => (b.datetime || 0) - (a.datetime || 0)).map(m => (
                  <div key={m.id} className="px-5 py-4 transition group" style={{ background: m.isRead ? "white" : "#f0fdf4" }}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                          {!m.isRead && <div className="w-1.5 h-1.5 rounded-full" style={{ background: "#059669" }} />}
                          <span className="text-[11px] opacity-50">{m.source}</span>
                          <span className="text-[11px] opacity-30">·</span>
                          <span className="text-[11px] opacity-50">{formatTimestamp(m.datetime)}</span>
                          <span className="text-[11px] opacity-30">·</span>
                          <span className="text-[11px] opacity-50">{timeAgo(m.datetime)} ago</span>
                        </div>
                        <a href={m.url} target="_blank" rel="noreferrer" onClick={() => !m.isRead && onMarkRead(m.id)} className="font-serif-h text-base font-semibold leading-snug hover:underline block mb-1">
                          {m.headline}
                        </a>
                        {m.summary && <p className="text-xs opacity-60 leading-relaxed line-clamp-2">{m.summary}</p>}
                      </div>
                      <div className="flex flex-col gap-1 opacity-40 group-hover:opacity-100 transition">
                        {!m.isRead && (
                          <button onClick={() => onMarkRead(m.id)} title="Mark read" className="p-1 rounded hover:bg-gray-100" style={{ color: "#059669" }}>
                            <Check size={12} />
                          </button>
                        )}
                        <button onClick={() => onDismissMatch(m.id)} title="Delete this match" className="p-1 rounded hover:bg-gray-100">
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Summary Card component ───────────────────────────────────────────────────
function SummaryCard({ row, onDelete }) {
  const s = row.data?.summary || {};
  const meta = row.data?.meta || {};
  const [expanded, setExpanded] = useState(true);

  const topicLabel = row.topic === "product"
    ? "Product focus"
    : row.topic === "custom"
      ? `Custom: ${row.data?.customTopic || ""}`
      : "Overall";

  return (
    <div className="rounded-2xl fade-in overflow-hidden" style={{ background: "white", border: "1px solid #ececec" }}>
      {/* Header */}
      <div className="p-5 flex items-start justify-between gap-3 cursor-pointer" onClick={() => setExpanded(e => !e)}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-xs font-bold px-2 py-0.5 rounded-md" style={{ background: "#f0f0ec" }}>${row.ticker}</span>
            <span className="text-[11px] px-2 py-0.5 rounded-md font-medium flex items-center gap-1" style={{ background: "#fef3c7", color: "#92400e" }}>
              <Calendar size={9} /> {row.data?.periodLabel || row.period}
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded-md font-medium flex items-center gap-1" style={{ background: "#dbeafe", color: "#1e40af" }}>
              <Target size={9} /> {topicLabel}
            </span>
            <span className="text-[11px] opacity-50">
              {row.data?.fromDate} → {row.data?.toDate}
            </span>
          </div>
          {s.headline_summary && (
            <p className="font-serif-h text-lg leading-snug font-medium" style={{ color: "#1a1a1a" }}>
              {s.headline_summary}
            </p>
          )}
          <div className="text-[11px] opacity-50 mt-2 flex items-center gap-2 flex-wrap">
            <span>Created {timeSinceText(new Date(row.created_at).getTime())}</span>
            {meta.costUSD != null && (
              <>
                <span>·</span>
                <span title={`${meta.tokens?.input || 0} input + ${meta.tokens?.output || 0} output tokens, ${meta.searches || 0} searches`}>
                  Cost: ${meta.costUSD?.toFixed(4)}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={e => { e.stopPropagation(); onDelete(); }} className="p-1.5 rounded-full opacity-40 hover:opacity-100 hover:bg-red-50 transition" style={{ color: "#dc2626" }}>
            <Trash2 size={13} />
          </button>
          <button className="p-1.5 rounded-full opacity-40 hover:opacity-100 hover:bg-gray-100 transition">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t" style={{ borderColor: "#f0f0ec" }}>
          {/* Key news */}
          {s.key_news?.length > 0 && (
            <div className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <Zap size={12} className="opacity-60" />
                <span className="text-xs font-semibold tracking-widest uppercase opacity-60">Key headlines</span>
              </div>
              <div className="space-y-4">
                {s.key_news.map((item, i) => (
                  <div key={i}>
                    <div className="font-serif-h text-base font-bold leading-snug mb-1">{item.headline}</div>
                    <p className="text-sm opacity-70 leading-relaxed mb-1.5">{item.description}</p>
                    {item.sources?.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {item.sources.map((src, j) => (
                          <a key={j} href={src.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full hover:opacity-80 transition" style={{ background: "#f7f7f3", color: "#525252" }}>
                            <ExternalLink size={9} /> {src.title || "Source"}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sentiment */}
          {s.sentiment && (
            <div className="px-5 py-4 border-t" style={{ borderColor: "#f0f0ec", background: "#fafaf7" }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold tracking-widest uppercase opacity-60">Market sentiment</span>
                {s.sentiment.rating && (
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{
                    background: s.sentiment.rating === "Bullish" ? "#dcfce7" : s.sentiment.rating === "Bearish" ? "#fee2e2" : s.sentiment.rating === "Mixed" ? "#fef3c7" : "#f0f0ec",
                    color:      s.sentiment.rating === "Bullish" ? "#166534" : s.sentiment.rating === "Bearish" ? "#991b1b" : s.sentiment.rating === "Mixed" ? "#92400e" : "#525252",
                  }}>
                    {s.sentiment.rating}
                  </span>
                )}
              </div>
              <p className="text-sm opacity-70 leading-relaxed">{s.sentiment.explanation}</p>
            </div>
          )}

          {/* Price performance */}
          {s.price_performance && (
            <div className="px-5 py-4 border-t" style={{ borderColor: "#f0f0ec" }}>
              <div className="flex items-center gap-2 mb-2">
                <TrendingUpIcon size={12} className="opacity-60" />
                <span className="text-xs font-semibold tracking-widest uppercase opacity-60">Price performance</span>
              </div>
              <p className="text-sm opacity-70 leading-relaxed">{s.price_performance}</p>
            </div>
          )}

          {/* Product focus */}
          {s.product_focus && (
            <div className="px-5 py-4 border-t" style={{ borderColor: "#f0f0ec", background: "#fafaf7" }}>
              <div className="flex items-center gap-2 mb-2">
                <Sparkles size={12} className="opacity-60" />
                <span className="text-xs font-semibold tracking-widest uppercase opacity-60">Product focus</span>
              </div>
              <p className="text-sm opacity-70 leading-relaxed">{s.product_focus}</p>
            </div>
          )}

          {/* Future predictions */}
          {s.future_predictions?.length > 0 && (
            <div className="px-5 py-4 border-t" style={{ borderColor: "#f0f0ec" }}>
              <div className="flex items-center gap-2 mb-2">
                <Target size={12} className="opacity-60" />
                <span className="text-xs font-semibold tracking-widest uppercase opacity-60">What to watch</span>
              </div>
              <ul className="space-y-1.5">
                {s.future_predictions.map((p, i) => (
                  <li key={i} className="text-sm opacity-70 leading-relaxed flex gap-2">
                    <span className="opacity-40 flex-shrink-0">→</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Events timeline */}
          {s.events_timeline?.length > 0 && (
            <div className="px-5 py-4 border-t" style={{ borderColor: "#f0f0ec", background: "#fafaf7" }}>
              <div className="flex items-center gap-2 mb-2">
                <Clock size={12} className="opacity-60" />
                <span className="text-xs font-semibold tracking-widest uppercase opacity-60">Events timeline</span>
              </div>
              <div className="space-y-2">
                {s.events_timeline.map((ev, i) => (
                  <div key={i} className="flex gap-3 items-start">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: "#e0f2fe", color: "#0369a1" }}>{ev.when}</span>
                    <span className="text-sm opacity-70 leading-relaxed">{ev.what}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
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
  const [view, setView]       = useState("feed");

  const [confirmDelete, setConfirmDelete] = useState(null);

  const [newCardTicker,  setNewCardTicker]  = useState("");
  const [newCardKeyword, setNewCardKeyword] = useState("");

  // ── Summarize state ─────────────────────────────────────────────────────────
  const [summaries, setSummaries] = useState([]);
  const [sumTicker,  setSumTicker]   = useState("");
  const [sumPeriod,  setSumPeriod]   = useState("1w");
  const [sumCustomFrom, setSumCustomFrom] = useState("");
  const [sumCustomTo,   setSumCustomTo]   = useState("");
  const [sumTopic,   setSumTopic]    = useState("overall");
  const [sumCustomTopic, setSumCustomTopic] = useState("");
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState(null);

  const totalUnread = useMemo(
    () => (state.watchCards || []).reduce((sum, c) => sum + c.matches.filter(m => !m.isRead).length, 0),
    [state.watchCards]
  );

  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Ticker · alerts` : "Ticker — Your market, distilled";
  }, [totalUnread]);

  // Hydrate
  useEffect(() => {
    (async () => {
      if (!supabase) { setCloudStatus("offline"); setHydrated(true); return; }
      try {
        const saved = await loadState();
        if (saved) {
          const migrated = {
            ...DEFAULT_STATE, ...saved,
            sectorGroups: saved.sectorGroups || DEFAULT_STATE.sectorGroups,
            customGroups: saved.customGroups || DEFAULT_STATE.customGroups,
            watchCards:   saved.watchCards   || [],
            activeTab:    saved.activeTab    || "sector",
          };
          delete migrated.watchKeywords;
          delete migrated.watchMatches;
          setState(migrated);
        }
        const loaded = await loadSummaries();
        setSummaries(loaded);
        setCloudStatus("synced");
      } catch { setCloudStatus("offline"); }
      setHydrated(true);
    })();
  }, []);

  useEffect(() => { if (hydrated) saveState(state); }, [state, hydrated]);

  const allTickers = useMemo(() => {
    const s = new Set();
    [...(state.sectorGroups || []), ...(state.customGroups || [])].forEach(g => g.tickers.forEach(t => s.add(t)));
    (state.watchCards || []).forEach(c => s.add(c.ticker));
    return [...s];
  }, [state.sectorGroups, state.customGroups, state.watchCards]);

  const activeGroups = state.activeTab === "sector" ? (state.sectorGroups || []) : (state.customGroups || []);
  const displayedTickers = useMemo(() => {
    const g = activeGroups.find(g => g.id === state.activeGroup);
    return g ? g.tickers : [];
  }, [activeGroups, state.activeGroup]);

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

  useEffect(() => {
    if (!hydrated) return;
    const items = Object.entries(newsByTicker).flatMap(([tk, arr]) =>
      arr.map(n => ({ key: `${tk}_${n.id || n.url}`, headline: n.headline }))
    );
    const untagged = items.filter(it => !tagsByNewsKey[it.key]);
    if (!untagged.length) return;
    setTaggingInProgress(true);
    tagNews(untagged).then(tags => setTagsByNewsKey(prev => ({ ...prev, ...tags }))).finally(() => setTaggingInProgress(false));
  }, [hydrated, newsByTicker]); // eslint-disable-line

  // Watching matches scan
  useEffect(() => {
    if (!hydrated || !(state.watchCards?.length)) return;
    let changed = false;
    const updated = state.watchCards.map(card => {
      const articles = newsByTicker[card.ticker] || [];
      const cardCreatedSec = Math.floor(card.createdAt / 1000);
      const existing = new Set(card.matches.map(m => m.newsId));
      const newOnes = [];
      articles.forEach(art => {
        if ((art.datetime || 0) < cardCreatedSec) return;
        if (!matchesKeyword(card.keyword, art)) return;
        const newsId = String(art.id || art.url);
        if (existing.has(newsId)) return;
        newOnes.push({
          id: "m" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
          newsId, headline: art.headline, summary: art.summary, datetime: art.datetime,
          url: art.url, source: art.source, isRead: false, matchedAt: Date.now(),
        });
      });
      if (!newOnes.length) return card;
      changed = true;
      return { ...card, matches: [...card.matches, ...newOnes] };
    });
    if (changed) {
      setState(s => ({ ...s, watchCards: updated }));
      if ("Notification" in window && Notification.permission === "granted") {
        const newCount = updated.reduce((acc, c, i) => acc + (c.matches.length - state.watchCards[i].matches.length), 0);
        if (newCount > 0) {
          try {
            new Notification("Ticker · new alert", { body: `${newCount} new headline${newCount > 1 ? "s" : ""} matched`, icon: "/favicon.svg" });
          } catch {}
        }
      }
    }
  }, [hydrated, newsByTicker, state.watchCards]); // eslint-disable-line

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
    if (activeTags.length > 0) items = items.filter(n => activeTags.some(t => (tagsByNewsKey[n._key] || []).includes(t)));
    return items.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
  }, [displayedTickers, newsByTicker, search, activeTags, tagsByNewsKey]);

  const pinnedItems = useMemo(() => Object.values(state.pinned || {}).sort((a, b) => b.pinnedAt - a.pinnedAt), [state.pinned]);
  const remindersNeeded = pinnedItems.filter(p => (Date.now() - p.pinnedAt) / 86400000 >= REMINDER_DAYS);

  const sortedCards = useMemo(() => [...(state.watchCards || [])].sort((a, b) => {
    const aU = a.matches.filter(m => !m.isRead).length;
    const bU = b.matches.filter(m => !m.isRead).length;
    if (aU !== bU) return bU - aU;
    return b.createdAt - a.createdAt;
  }), [state.watchCards]);

  // ── Mutators ──────────────────────────────────────────────────────────────
  const updateState = fn => setState(prev => fn(prev));
  const setSelected = tk => updateState(s => ({ ...s, selected: tk }));
  const setActiveGroup = id => updateState(s => ({ ...s, activeGroup: id }));
  const setActiveTab = tab => {
    const groups = tab === "sector" ? state.sectorGroups : state.customGroups;
    updateState(s => ({ ...s, activeTab: tab, activeGroup: groups?.[0]?.id || "" }));
  };
  const togglePin = (ticker, news) => updateState(s => {
    const next = { ...s.pinned };
    const key = String(news.id || news.url);
    if (next[key]) delete next[key]; else next[key] = { ticker, news, pinnedAt: Date.now(), key };
    return { ...s, pinned: next };
  });
  const addTicker = () => {
    const t = newTicker.trim().toUpperCase();
    if (!t) return;
    const targetId = newTickerGroup;
    updateState(s => {
      const upd = (groups) => groups.map(g => g.id === targetId && !g.tickers.includes(t) ? { ...g, tickers: [...g.tickers, t] } : g);
      return {
        ...s,
        sectorGroups: state.activeTab === "sector" ? upd(s.sectorGroups) : s.sectorGroups,
        customGroups: state.activeTab === "custom" ? upd(s.customGroups) : s.customGroups,
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
      if (state.activeTab === "sector") return { ...s, sectorGroups: [...s.sectorGroups, { id, name, tickers: [] }], activeGroup: id };
      return { ...s, customGroups: [...s.customGroups, { id, name, tickers: [] }], activeGroup: id };
    });
    setNewGroupName(""); setShowAddGroup(false);
  };
  const requestDeleteTicker = tk => setConfirmDelete({ type: "ticker", id: tk, label: `$${tk}` });
  const requestDeleteGroup  = (gid, name) => setConfirmDelete({ type: "group", id: gid, label: `"${name}"` });
  const requestDeleteCard   = (cardId, label) => setConfirmDelete({ type: "card", id: cardId, label });
  const requestDeleteSummary = (id, ticker) => setConfirmDelete({ type: "summary", id, label: `summary for $${ticker}` });

  const executeDelete = async () => {
    if (!confirmDelete) return;
    if (confirmDelete.type === "ticker") {
      const tk = confirmDelete.id;
      updateState(s => ({
        ...s,
        sectorGroups: s.sectorGroups.map(g => ({ ...g, tickers: g.tickers.filter(t => t !== tk) })),
        customGroups: s.customGroups.map(g => ({ ...g, tickers: g.tickers.filter(t => t !== tk) })),
      }));
    } else if (confirmDelete.type === "group") {
      const gid = confirmDelete.id;
      updateState(s => {
        if (state.activeTab === "sector") {
          const next = s.sectorGroups.filter(g => g.id !== gid);
          return { ...s, sectorGroups: next, activeGroup: next[0]?.id || "" };
        }
        const next = s.customGroups.filter(g => g.id !== gid);
        return { ...s, customGroups: next, activeGroup: next[0]?.id || "" };
      });
    } else if (confirmDelete.type === "card") {
      const cardId = confirmDelete.id;
      updateState(s => ({ ...s, watchCards: s.watchCards.filter(c => c.id !== cardId) }));
    } else if (confirmDelete.type === "summary") {
      const id = confirmDelete.id;
      setSummaries(prev => prev.filter(r => r.id !== id));
      await deleteSummary(id);
    }
    setConfirmDelete(null);
  };

  const createWatchCard = () => {
    const ticker = newCardTicker.trim().toUpperCase();
    const keyword = newCardKeyword.trim();
    if (!ticker || !keyword) return;
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    const id = "wc" + Date.now();
    updateState(s => ({ ...s, watchCards: [{ id, ticker, keyword, createdAt: Date.now(), isOpen: true, matches: [] }, ...s.watchCards] }));
    setNewCardTicker(""); setNewCardKeyword("");
    if (!quotes[ticker]) loadTicker(ticker);
  };
  const toggleCardOpen = cardId => updateState(s => ({ ...s, watchCards: s.watchCards.map(c => c.id === cardId ? { ...c, isOpen: !c.isOpen } : c) }));
  const markMatchRead = (cardId, matchId) => updateState(s => ({ ...s, watchCards: s.watchCards.map(c => c.id !== cardId ? c : { ...c, matches: c.matches.map(m => m.id === matchId ? { ...m, isRead: true } : m) }) }));
  const markAllRead = cardId => updateState(s => ({ ...s, watchCards: s.watchCards.map(c => c.id !== cardId ? c : { ...c, matches: c.matches.map(m => ({ ...m, isRead: true })) }) }));
  const dismissMatch = (cardId, matchId) => updateState(s => ({ ...s, watchCards: s.watchCards.map(c => c.id !== cardId ? c : { ...c, matches: c.matches.filter(m => m.id !== matchId) }) }));

  // ── Summarize: generate ─────────────────────────────────────────────────────
  const runSummary = async () => {
    const ticker = sumTicker.trim().toUpperCase();
    if (!ticker) { setSummaryError("Please enter a ticker"); return; }
    if (sumPeriod === "custom" && (!sumCustomFrom || !sumCustomTo)) {
      setSummaryError("Please set custom from/to dates"); return;
    }
    if (sumTopic === "custom" && !sumCustomTopic.trim()) {
      setSummaryError("Please describe your custom topic"); return;
    }

    setSummaryError(null);
    setGeneratingSummary(true);

    try {
      // 1) Get news for the period — fetch via Finnhub
      const days = PERIOD_OPTIONS.find(p => p.id === sumPeriod)?.days || 7;
      const periodLabel = sumPeriod === "custom"
        ? `${sumCustomFrom} → ${sumCustomTo}`
        : PERIOD_OPTIONS.find(p => p.id === sumPeriod)?.label || sumPeriod;

      let newsList = [];
      try {
        // Finnhub free tier capped around 30 days; for longer the web search will fill in
        newsList = await getNews(ticker, Math.min(days, 30));
      } catch {}

      const { from, to } = getPeriodDates(sumPeriod, sumCustomFrom, sumCustomTo);
      const fromSec = new Date(from).getTime() / 1000;
      const toSec   = new Date(to).getTime() / 1000 + 86400;
      const periodNews = (newsList || [])
        .filter(n => (n.datetime || 0) >= fromSec && (n.datetime || 0) <= toSec)
        .slice(0, 25);

      // 2) Get price context via candles
      let priceContext = null;
      try {
        const months = days <= 30 ? 1 : days <= 90 ? 3 : 6;
        const candles = await getCandles(ticker, months);
        const periodCandles = candles.filter(c => c.ts >= fromSec * 1000 && c.ts <= toSec * 1000);
        if (periodCandles.length >= 2) {
          const startPx = periodCandles[0].close;
          const endPx   = periodCandles[periodCandles.length - 1].close;
          const high    = Math.max(...periodCandles.map(c => c.high));
          const low     = Math.min(...periodCandles.map(c => c.low));
          priceContext = {
            startPx, endPx,
            pctChange: ((endPx - startPx) / startPx) * 100,
            high, low,
          };
        }
      } catch {}

      // 3) Call the summarize API
      const { summary, meta } = await generateSummary({
        ticker, period: sumPeriod, periodLabel,
        fromDate: from, toDate: to,
        topic: sumTopic,
        customTopic: sumCustomTopic,
        priceContext,
        newsItems: periodNews,
      });

      // 4) Persist
      const id = "sum_" + Date.now();
      const row = {
        id, ticker, period: sumPeriod, topic: sumTopic,
        data: {
          summary, meta,
          periodLabel, fromDate: from, toDate: to,
          customTopic: sumCustomTopic,
        },
        created_at: new Date().toISOString(),
      };
      await saveSummary(row);
      setSummaries(prev => [row, ...prev]);

      // Reset form
      setSumTicker(""); setSumCustomTopic("");
    } catch (e) {
      setSummaryError(e.message || String(e));
    } finally {
      setGeneratingSummary(false);
    }
  };

  const toggleTag = tag => setActiveTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  const refreshAll = () => allTickers.forEach(loadTicker);

  const selected = state.selected;
  const quote   = quotes[selected]   || { c: 0, d: 0, dp: 0 };
  const profile = profiles[selected] || {};
  const isUp    = (quote.d || 0) >= 0;
  const daysSince = ts => Math.floor((Date.now() - ts) / 86400000);

  useEffect(() => {
    if (!hydrated) return;
    const groups = state.activeTab === "sector" ? state.sectorGroups : state.customGroups;
    if (!groups.find(g => g.id === state.activeGroup) && groups.length > 0)
      updateState(s => ({ ...s, activeGroup: groups[0].id }));
  }, [hydrated, state.activeTab]); // eslint-disable-line

  useEffect(() => {
    if (showAddTicker) {
      const groups = state.activeTab === "sector" ? state.sectorGroups : state.customGroups;
      setNewTickerGroup(state.activeGroup || groups[0]?.id || "");
    }
  }, [showAddTicker]); // eslint-disable-line

  return (
    <div className="min-h-screen w-full">
      <header className="border-b sticky top-0 z-20 backdrop-blur-md" style={{ borderColor: "#ececec", background: "rgba(250,250,247,0.85)" }}>
        <div className="max-w-7xl mx-auto px-8 py-4 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-8">
            <div>
              <h1 className="font-serif-h text-2xl font-semibold tracking-tight">Ticker<span style={{ color: "#c2410c" }}>.</span></h1>
              <div className="text-[10px] tracking-[0.25em] uppercase opacity-50 mt-0.5">Your market, distilled</div>
            </div>
            <nav className="flex items-center gap-1">
              {[
                { id: "feed",      label: "Feed" },
                { id: "pinned",    label: "Pinned",    badge: pinnedItems.length },
                { id: "watching",  label: "Watching",  badge: totalUnread, badgeColor: "#059669" },
                { id: "summarize", label: "Summarize", badge: summaries.length, badgeColor: "#7c3aed" },
              ].map(tab => (
                <button key={tab.id} onClick={() => setView(tab.id)} className="px-3 py-1.5 text-sm rounded-full transition-all flex items-center gap-1.5"
                  style={{ background: view === tab.id ? "#1a1a1a" : "transparent", color: view === tab.id ? "#fafaf7" : "#1a1a1a" }}>
                  {tab.label}
                  {tab.badge > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                      style={{ background: view === tab.id ? "#fafaf7" : (tab.badgeColor || "#1a1a1a"), color: view === tab.id ? "#1a1a1a" : "#fafaf7" }}>
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
            <button onClick={() => setShowSync(true)} className="p-1.5 rounded-full hover:bg-gray-100 transition" style={{ color: cloudStatus === "synced" ? "#059669" : cloudStatus === "offline" ? "#dc2626" : "#a3a3a3" }}>
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
      {confirmDelete && (
        <ConfirmModal
          title={`Remove ${confirmDelete.label}?`}
          message={
            confirmDelete.type === "ticker"  ? `${confirmDelete.label} will be removed from all groups. Pinned news and watching cards using this ticker are kept.` :
            confirmDelete.type === "group"   ? `The group ${confirmDelete.label} will be deleted. Tickers inside are not deleted — they remain in other groups.` :
            confirmDelete.type === "card"    ? `The watching card ${confirmDelete.label} and all its saved matches will be permanently removed.` :
                                               `This ${confirmDelete.label} will be permanently removed. This action cannot be undone.`
          }
          onConfirm={executeDelete} onCancel={() => setConfirmDelete(null)} />
      )}

      <div className="max-w-7xl mx-auto px-8 py-8 grid grid-cols-12 gap-8">
        <aside className="col-span-3">
          <div className="flex gap-1 mb-4 p-1 rounded-xl" style={{ background: "#f0f0ec" }}>
            <button onClick={() => setActiveTab("sector")} className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-lg transition-all" style={{ background: state.activeTab === "sector" ? "white" : "transparent", color: "#1a1a1a", boxShadow: state.activeTab === "sector" ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}>
              <Layers size={11} /> Sector
            </button>
            <button onClick={() => setActiveTab("custom")} className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-lg transition-all" style={{ background: state.activeTab === "custom" ? "white" : "transparent", color: "#1a1a1a", boxShadow: state.activeTab === "custom" ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}>
              <Tag size={11} /> Custom
            </button>
          </div>

          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold tracking-widest uppercase opacity-50">{state.activeTab === "sector" ? "Sectors" : "My Groups"}</h2>
            <button onClick={() => setShowAddGroup(true)} className="opacity-50 hover:opacity-100 transition"><FolderPlus size={14} /></button>
          </div>

          {showAddGroup && (
            <div className="mb-3 p-3 rounded-xl fade-in" style={{ background: "white", border: "1px solid #e5e5e5" }}>
              <input autoFocus value={newGroupName} onChange={e => setNewGroupName(e.target.value)} onKeyDown={e => e.key === "Enter" && addGroup()} placeholder={state.activeTab === "sector" ? "e.g. Healthcare" : "e.g. Speculative plays"} className="w-full text-sm focus:outline-none mb-2" />
              <div className="flex gap-1.5">
                <button onClick={addGroup} className="flex-1 text-xs py-1.5 rounded-md text-white" style={{ background: "#1a1a1a" }}>Create</button>
                <button onClick={() => setShowAddGroup(false)} className="px-3 text-xs py-1.5 rounded-md" style={{ background: "#f0f0ec" }}>Cancel</button>
              </div>
            </div>
          )}

          <div className="space-y-0.5 mb-5">
            {activeGroups.map(g => (
              <GroupRow key={g.id} active={state.activeGroup === g.id} onClick={() => setActiveGroup(g.id)} onRemove={() => requestDeleteGroup(g.id, g.name)} name={g.name} count={g.tickers.length} />
            ))}
            {activeGroups.length === 0 && <div className="text-xs opacity-40 italic px-3 py-2">No groups yet.</div>}
          </div>

          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold tracking-widest uppercase opacity-50">Tickers</h2>
            <button onClick={() => setShowAddTicker(true)} className="opacity-50 hover:opacity-100 transition"><Plus size={14} /></button>
          </div>

          {showAddTicker && (
            <div className="mb-3 p-3 rounded-xl fade-in" style={{ background: "white", border: "1px solid #e5e5e5" }}>
              <input autoFocus value={newTicker} onChange={e => setNewTicker(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && addTicker()} placeholder="e.g. AAPL" className="w-full text-sm focus:outline-none mb-2 font-medium" />
              <div className="text-[10px] opacity-50 mb-1">Add to group:</div>
              <select value={newTickerGroup} onChange={e => setNewTickerGroup(e.target.value)} className="w-full text-xs py-1.5 px-2 rounded-md mb-2 focus:outline-none" style={{ background: "#f7f7f3", border: "1px solid #e5e5e5" }}>
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
                  <div className="flex items-center gap-1">
                    <div className="text-right">
                      <div className="text-xs font-medium">{p.c ? `$${p.c.toFixed(2)}` : "—"}</div>
                      <div className="text-[11px]" style={{ color: up ? "#059669" : "#dc2626" }}>{p.c ? `${up ? "+" : ""}${(p.dp || 0).toFixed(2)}%` : ""}</div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); requestDeleteTicker(tk); }} className="opacity-0 group-hover:opacity-40 hover:opacity-100 transition p-1 rounded hover:bg-red-50" style={{ color: "#dc2626" }}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              );
            })}
            {displayedTickers.length === 0 && <div className="text-xs opacity-40 italic px-3 py-4">No tickers in this group yet.</div>}
          </div>

          {state.activeTab === "custom" && (
            <div className="mt-4 p-3 rounded-xl text-[11px] opacity-50 leading-relaxed" style={{ background: "#f7f7f3" }}>
              A ticker can belong to multiple Custom groups. Add it again in another group — it stays in both.
            </div>
          )}
        </aside>

        <main className="col-span-9">
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
                  <h3 className="font-serif-h text-2xl font-semibold">{activeGroups.find(g => g.id === state.activeGroup)?.name || "Headlines"}</h3>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setShowFilter(s => !s)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium transition" style={{ background: activeTags.length > 0 || showFilter ? "#1a1a1a" : "white", color: activeTags.length > 0 || showFilter ? "#fafaf7" : "#1a1a1a", border: "1px solid " + (activeTags.length > 0 || showFilter ? "#1a1a1a" : "#e5e5e5") }}>
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
                        const style = TAG_STYLES[tag];
                        return (
                          <button key={tag} onClick={() => toggleTag(tag)} className="text-xs px-3 py-1.5 rounded-full font-medium transition-all" style={{ background: active ? style.color : style.bg, color: active ? "white" : style.color, border: "1px solid " + (active ? style.color : "transparent") }}>
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
                    <NewsCard key={n._key} news={n} tags={tagsByNewsKey[n._key] || []} pinned={!!state.pinned?.[String(n.id || n.url)]} onPin={() => togglePin(n.ticker, n)} onSelect={() => setSelected(n.ticker)} onTagClick={toggleTag} />
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
                              <span className="text-[11px] opacity-50">{formatTimestamp(p.news.datetime)}</span>
                              <span className="text-[11px] opacity-30">·</span>
                              <span className="text-[11px] opacity-50">{timeAgo(p.news.datetime)} ago</span>
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

          {view === "watching" && (
            <section>
              <div className="mb-6">
                <h2 className="font-serif-h text-3xl font-semibold mb-1">Watching</h2>
                <p className="text-sm opacity-60">Create cards to track new headlines matching your keywords. Only news published <em>after</em> a card is created counts.</p>
              </div>
              <div className="rounded-2xl p-6 mb-6" style={{ background: "white", border: "1px solid #ececec" }}>
                <div className="flex items-center gap-2 mb-4">
                  <Plus size={14} className="opacity-50" />
                  <div className="text-sm font-semibold">New watching card</div>
                </div>
                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-3">
                    <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Ticker</label>
                    <input value={newCardTicker} onChange={e => setNewCardTicker(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && createWatchCard()} placeholder="e.g. NVDA" className="w-full text-sm font-semibold px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition" style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                  </div>
                  <div className="col-span-7">
                    <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Keyword</label>
                    <input value={newCardKeyword} onChange={e => setNewCardKeyword(e.target.value)} onKeyDown={e => e.key === "Enter" && createWatchCard()} placeholder="e.g. data center, FDA approval, lawsuit" className="w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition" style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                  </div>
                  <div className="col-span-2 flex items-end">
                    <button onClick={createWatchCard} disabled={!newCardTicker.trim() || !newCardKeyword.trim()} className="w-full py-2 rounded-lg text-white text-sm font-medium transition disabled:opacity-30" style={{ background: "#1a1a1a" }}>Create</button>
                  </div>
                </div>
                <p className="text-[11px] opacity-50 mt-3">Tip: keywords match anywhere in a headline or summary (case-insensitive).</p>
              </div>
              {sortedCards.length === 0 ? (
                <div className="rounded-2xl p-12 text-center" style={{ background: "white", border: "1px solid #ececec" }}>
                  <Eye size={32} className="mx-auto opacity-20 mb-3" />
                  <div className="text-sm opacity-60">No watching cards yet.</div>
                </div>
              ) : (
                <div className="space-y-3">
                  {sortedCards.map(card => (
                    <WatchingCard key={card.id} card={card} onToggleOpen={() => toggleCardOpen(card.id)} onDelete={() => requestDeleteCard(card.id, `$${card.ticker} · "${card.keyword}"`)} onMarkRead={matchId => markMatchRead(card.id, matchId)} onMarkAllRead={() => markAllRead(card.id)} onDismissMatch={matchId => dismissMatch(card.id, matchId)} />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ── SUMMARIZE VIEW ── */}
          {view === "summarize" && (
            <section>
              <div className="mb-6">
                <h2 className="font-serif-h text-3xl font-semibold mb-1">Summarize</h2>
                <p className="text-sm opacity-60">Get an AI-generated summary of a stock's news, sentiment, price action, and what to watch — for any period and topic.</p>
              </div>

              {/* Generator form */}
              <div className="rounded-2xl p-6 mb-6" style={{ background: "white", border: "1px solid #ececec" }}>
                <div className="flex items-center gap-2 mb-5">
                  <Sparkles size={14} className="opacity-50" />
                  <div className="text-sm font-semibold">New summary</div>
                </div>

                <div className="grid grid-cols-12 gap-3">
                  {/* Ticker */}
                  <div className="col-span-3">
                    <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Ticker</label>
                    <input value={sumTicker} onChange={e => setSumTicker(e.target.value.toUpperCase())} placeholder="e.g. AMD" className="w-full text-sm font-semibold px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition" style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                  </div>

                  {/* Period */}
                  <div className="col-span-5">
                    <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Period</label>
                    <div className="flex gap-1 flex-wrap">
                      {PERIOD_OPTIONS.map(p => (
                        <button key={p.id} onClick={() => setSumPeriod(p.id)} className="text-xs px-3 py-2 rounded-lg font-medium transition" style={{ background: sumPeriod === p.id ? "#1a1a1a" : "#f0f0ec", color: sumPeriod === p.id ? "white" : "#1a1a1a" }}>
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Topic */}
                  <div className="col-span-4">
                    <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Topic</label>
                    <div className="flex gap-1 flex-wrap">
                      {[
                        { id: "overall", label: "Overall" },
                        { id: "product", label: "Product" },
                        { id: "custom",  label: "Custom" },
                      ].map(t => (
                        <button key={t.id} onClick={() => setSumTopic(t.id)} className="text-xs px-3 py-2 rounded-lg font-medium transition" style={{ background: sumTopic === t.id ? "#1a1a1a" : "#f0f0ec", color: sumTopic === t.id ? "white" : "#1a1a1a" }}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Custom period dates */}
                  {sumPeriod === "custom" && (
                    <>
                      <div className="col-span-3">
                        <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">From</label>
                        <input type="date" value={sumCustomFrom} onChange={e => setSumCustomFrom(e.target.value)} className="w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition" style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                      </div>
                      <div className="col-span-3">
                        <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">To</label>
                        <input type="date" value={sumCustomTo} onChange={e => setSumCustomTo(e.target.value)} className="w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition" style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                      </div>
                    </>
                  )}

                  {/* Custom topic */}
                  {sumTopic === "custom" && (
                    <div className="col-span-12">
                      <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Custom topic</label>
                      <input value={sumCustomTopic} onChange={e => setSumCustomTopic(e.target.value)} placeholder="e.g. China exposure, AI roadmap, supply chain" className="w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition" style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                    </div>
                  )}

                  <div className="col-span-12 flex items-center justify-between mt-2">
                    <p className="text-[11px] opacity-50">
                      Est. cost: ~$0.02–$0.06 per summary. Web search is enabled for periods of 1 month or longer.
                    </p>
                    <button onClick={runSummary} disabled={generatingSummary || !sumTicker.trim()} className="px-5 py-2 rounded-lg text-white text-sm font-medium transition disabled:opacity-30 flex items-center gap-2" style={{ background: "#1a1a1a" }}>
                      {generatingSummary ? (
                        <><RefreshCw size={12} className="animate-spin" /> Generating…</>
                      ) : (
                        <><Sparkles size={12} /> Generate summary</>
                      )}
                    </button>
                  </div>

                  {summaryError && (
                    <div className="col-span-12 text-xs px-3 py-2 rounded-lg" style={{ background: "#fee2e2", color: "#991b1b" }}>
                      {summaryError}
                    </div>
                  )}
                </div>
              </div>

              {/* Existing summaries */}
              {summaries.length === 0 ? (
                <div className="rounded-2xl p-12 text-center" style={{ background: "white", border: "1px solid #ececec" }}>
                  <FileText size={32} className="mx-auto opacity-20 mb-3" />
                  <div className="text-sm opacity-60">No summaries yet.</div>
                  <div className="text-xs opacity-40 mt-1">Generate one above. Summaries are saved until you delete them.</div>
                </div>
              ) : (
                <div className="space-y-4">
                  {summaries.map(row => (
                    <SummaryCard key={row.id} row={row} onDelete={() => requestDeleteSummary(row.id, row.ticker)} />
                  ))}
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
