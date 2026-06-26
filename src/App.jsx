import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  TrendingUp, TrendingDown, Plus, X, Star, Bookmark, Search, FolderPlus,
  ChevronRight, ChevronDown, Bell, RefreshCw, ExternalLink, Cloud, CloudOff,
  Copy, Check, Sparkles, Filter, Eye, Trash2, AlertCircle, Tag, Layers,
  CheckCheck, FileText, Calendar, Target, TrendingUpIcon, Zap, Clock,
  BellRing, Mail, DollarSign, AlertCircle as AlertCircleIcon, Power,
  CalendarClock, Repeat, BookOpen, Lightbulb, ListChecks,
  Eye as EyeIcon, Crosshair, ArrowUpRight, ArrowDownRight, Activity,
  ClipboardPaste, FileUp,
  Settings, Cpu, Globe,
  Percent, BarChart3, Banknote, Scale, Users, Hammer, GitCompare, Coins,
  Library, FolderOpen, Save, Database
} from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, LineChart, Line, Legend, Cell, CartesianGrid } from "recharts";
import { getQuote, getProfile, getNews, getCandles, classifyImpact, timeAgo } from "./lib/finnhub";
import { supabase, getIdentity, setIdentity, loadState, saveState } from "./lib/supabase";
import { tagNews, AVAILABLE_TAGS, TAG_STYLES } from "./lib/tagger";
import { loadSummaries, saveSummary, deleteSummary, generateSummary } from "./lib/summaries";
import { loadUserEmail, saveUserEmail, loadAlerts, createAlert, stopAlert, deleteAlert } from "./lib/alerts";
import { loadCatchupCards, saveCatchupCard, deleteCatchupCard, generateCatchupBriefing, computeDueState, periodToDays } from "./lib/catchup";
import { loadHawkeyeCards, saveHawkeyeCard, deleteHawkeyeCard, describeCondition, registerTickersForBootstrap, loadBootstrapStatus, saveTickerHistory, loadTickerHistory, runHawkeyeCheckNow } from "./lib/hawkeye";
import { loadModelPrefs, saveModelPrefs, loadAvailableProviders, labelForModel, DEFAULT_COMPLEX_MODEL, DEFAULT_SIMPLE_MODEL } from "./lib/model-prefs";
import { parseHistoricalPaste } from "./lib/parseHistoricalPaste";
import { parseTicker, formatTicker, normalizeTicker, isUSTicker, formatPrice, getMarket, tickerCode, tickerMarket, MARKETS, MARKET_BADGE_STYLES, TICKER_INPUT_PLACEHOLDER, TICKER_INPUT_HELP } from "./lib/markets";
import { loadCompareStocks, saveCompareStock, deleteCompareStock, updateCompareStockCurrency, updateCompareStockTicker,
  updateCompareStockScale, updateCompareStockOffset,
  loadCompareGroups, saveCompareGroup, deleteCompareGroup, fetchPriceAndFx, COMPARE_COLORS } from "./lib/compare";
import { parseFinancials } from "./lib/parseFinancials";
import { TOPICS, buildTopic, formatCell, formatCellValue, fmtMoney, fmtPercent, fmtRatio, fmtNumber, CURRENCIES, SCALE_OPTIONS, sortedQuarters } from "./lib/compareEngine";

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

// Strip XML-style citation/source tags that may leak through from web search responses
function stripTags(value) {
  if (typeof value === "string") {
    return value
      .replace(/<cite\s+[^>]*>([\s\S]*?)<\/cite>/gi, "$1")
      .replace(/<\/?cite[^>]*>/gi, "")
      .replace(/<(source|ref|citation)\s+[^>]*>([\s\S]*?)<\/\1>/gi, "$2")
      .replace(/<\/?(source|ref|citation)[^>]*>/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  if (Array.isArray(value)) return value.map(stripTags);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = stripTags(value[k]);
    return out;
  }
  return value;
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
function MarketBadge({ market, size = "xs" }) {
  if (!market || market === "US") return null;
  const style = MARKET_BADGE_STYLES[market] || { bg: "#f0f0ec", fg: "#525252" };
  const px = size === "xs" ? "text-[9px] px-1 py-0.5" : "text-[10px] px-1.5 py-0.5";
  return (
    <span className={`font-bold uppercase tracking-wider rounded ${px} flex-shrink-0`}
      style={{ background: style.bg, color: style.fg }}>
      {market}
    </span>
  );
}

// Renders a ticker the way it should appear in the UI:
//   US:      $AAPL   (optional dollar sign)
//   Non-US:  [HK] 0700   (market badge + code)
function TickerLabel({ symbol, showDollar = false, badgeSize = "xs", className = "" }) {
  const market = tickerMarket(symbol);
  const code = tickerCode(symbol);
  if (market === "US") {
    return <span className={className}>{showDollar ? "$" : ""}{code}</span>;
  }
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <MarketBadge market={market} size={badgeSize} />
      <span>{code}</span>
    </span>
  );
}

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

function HawkeyeMiniChart({ ticker, candles, livePrice }) {
  const data = useMemo(() => {
    if (!candles || candles.length === 0) return [];
    return candles.slice(-90).map(c => ({
      date: new Date(c.ts).toISOString().slice(5, 10),  // MM-DD
      close: c.close,
    }));
  }, [candles]);

  if (data.length === 0) {
    return <div className="text-xs opacity-40 italic text-center py-6">No candle data yet</div>;
  }

  const closes = data.map(d => d.close);
  const minC = Math.min(...closes) * 0.99;
  const maxC = Math.max(...closes) * 1.01;
  const tickInterval = Math.max(1, Math.floor(data.length / 6));
  const fillId = `hk-fill-${ticker}`;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] tracking-widest uppercase opacity-40">Last {data.length} sessions</span>
        {livePrice > 0 && (
          <span className="text-[10px] opacity-60">Live: <span className="font-semibold">{formatPrice(ticker, livePrice)}</span></span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#7c3aed" stopOpacity={0.22} />
              <stop offset="100%" stopColor="#7c3aed" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#a3a3a3" }} tickLine={false} axisLine={false} interval={tickInterval} />
          <YAxis domain={[minC, maxC]} tick={{ fontSize: 9, fill: "#a3a3a3" }} tickLine={false} axisLine={false} tickFormatter={v => `$${v.toFixed(0)}`} width={42} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#e5e5e5", strokeWidth: 1 }} />
          <Area type="monotone" dataKey="close" stroke="#7c3aed" strokeWidth={1.5} fill={`url(#${fillId})`} dot={false} activeDot={{ r: 3, fill: "#7c3aed", strokeWidth: 0 }} />
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
            <button onClick={onSelect} className="text-xs font-bold px-2 py-0.5 rounded-md hover:bg-gray-200 inline-flex items-center" style={{ background: "#f0f0ec" }}><TickerLabel symbol={news.ticker} showDollar={true} /></button>
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

function SettingsModal({ modelPrefs, settingsDraft, setSettingsDraft, availableProviders, providersLoading, settingsSaving, onRefresh, onSave, onClose }) {
  const { providers = [] } = availableProviders || {};

  // Flatten all models into one list with provider context, used to render dropdown options
  const allModels = providers.flatMap(p =>
    (p.models || []).map(m => ({ ...m, providerName: p.name, providerConfigured: p.configured }))
  );

  // Group dropdown options by provider for visual grouping
  const renderDropdown = (value, onChange, idSuffix) => (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-gray-900 transition"
      style={{ background: "#fafaf7", border: "1px solid #e5e5e5" }}
      disabled={providersLoading}
    >
      {/* Always include the current value even if not in returned list (e.g. provider not configured) */}
      {value && !allModels.find(m => m.id === value) && (
        <option value={value}>{labelForModel(value, availableProviders)} (current)</option>
      )}
      {providers.map(p => (
        p.models && p.models.length > 0 ? (
          <optgroup key={p.id + idSuffix} label={p.name}>
            {p.models.map(m => (
              <option key={m.id} value={m.id}>{m.display_name}</option>
            ))}
          </optgroup>
        ) : null
      ))}
    </select>
  );

  const setComplex = (v) => setSettingsDraft(d => ({ ...d, complex_model: v }));
  const setSimple  = (v) => setSettingsDraft(d => ({ ...d, simple_model:  v }));

  const dirty = settingsDraft.complex_model !== modelPrefs.complex_model ||
                settingsDraft.simple_model  !== modelPrefs.simple_model;

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-lg rounded-2xl p-6 fade-in max-h-[90vh] overflow-y-auto" style={{ background: "white" }}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-serif-h text-xl font-semibold">Settings</h3>
          <button onClick={onClose} className="p-1 opacity-50 hover:opacity-100"><X size={16} /></button>
        </div>
        <p className="text-sm opacity-60 mb-5">Choose which AI model handles different types of tasks.</p>

        <div className="mb-4 p-4 rounded-xl" style={{ background: "#fafaf7", border: "1px solid #f0f0ec" }}>
          <div className="flex items-center gap-2 mb-1">
            <Cpu size={12} style={{ color: "#7c3aed" }} />
            <span className="text-[11px] font-semibold tracking-widest uppercase opacity-60">AI Models</span>
          </div>

          {/* Complex task */}
          <div className="mb-4">
            <label className="text-sm font-semibold block mt-3">Complex Task Model</label>
            <p className="text-[11px] opacity-60 mb-2">Used by: <span className="font-medium">Summarize</span>, <span className="font-medium">Catchup briefings</span>. Pick a capable model — these need reasoning, long context, and structured output.</p>
            {renderDropdown(settingsDraft.complex_model, setComplex, "_complex")}
          </div>

          {/* Simple task */}
          <div className="mb-2">
            <label className="text-sm font-semibold block">Simple Task Model</label>
            <p className="text-[11px] opacity-60 mb-2">Used by: <span className="font-medium">News tagging</span>. Pick a cheap/fast model — this is high volume, low complexity classification.</p>
            {renderDropdown(settingsDraft.simple_model, setSimple, "_simple")}
          </div>

          {/* Provider status notes */}
          <div className="mt-3 space-y-1">
            {providers.map(p => (
              !p.configured ? (
                <div key={p.id} className="text-[11px] flex items-start gap-1.5 opacity-60">
                  <AlertCircle size={10} className="flex-shrink-0 mt-0.5" />
                  <span><span className="font-medium">{p.name}</span> not configured. {p.configure_hint || `Add the relevant API key to your Vercel environment variables.`}</span>
                </div>
              ) : p.error ? (
                <div key={p.id} className="text-[11px] flex items-start gap-1.5" style={{ color: "#dc2626" }}>
                  <AlertCircle size={10} className="flex-shrink-0 mt-0.5" />
                  <span><span className="font-medium">{p.name}</span> error: {p.error}</span>
                </div>
              ) : null
            ))}
          </div>

          <div className="text-[11px] opacity-50 mt-3 pt-3 border-t" style={{ borderColor: "#e5e5e5" }}>
            <p className="mb-1"><span className="font-semibold">Note:</span> Web search in Summarize and Catchup is only available with Anthropic models. Other providers will rely only on news fetched from Finnhub.</p>
            <p>Prompt caching discounts are also Anthropic-only.</p>
          </div>

          <div className="flex justify-end mt-3">
            <button
              onClick={onRefresh}
              disabled={providersLoading}
              className="text-[11px] flex items-center gap-1 opacity-60 hover:opacity-100 disabled:opacity-30">
              <RefreshCw size={10} className={providersLoading ? "animate-spin" : ""} /> Refresh model list
            </button>
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button
            onClick={onSave}
            disabled={!dirty || settingsSaving}
            className="flex-1 py-2 rounded-md text-white text-sm font-medium transition disabled:opacity-40"
            style={{ background: "#1a1a1a" }}>
            {settingsSaving ? "Saving…" : "Save changes"}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-md text-sm" style={{ background: "#f0f0ec" }}>Cancel</button>
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
            <span className="text-xs font-bold px-2 py-0.5 rounded-md inline-flex items-center" style={{ background: "#f0f0ec" }}><TickerLabel symbol={card.ticker} showDollar={true} /></span>
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
  // stripTags cleans any XML citation/source tags that may have been saved in older summaries
  const s = useMemo(() => stripTags(row.data?.summary || {}), [row.data]);
  const meta = row.data?.meta || {};
  const [expanded, setExpanded] = useState(false);

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
// ── Compare feature components ──────────────────────────────────────────────

const TOPIC_ICONS = {
  TrendingUp, Percent, Target, LineChart: BarChart3, Banknote, Scale,
  Users, Hammer, RefreshCw, Tag, Lightbulb,
};

// Tooltip for compare charts — currency/percent aware
function CompareTooltip({ active, payload, label, unit, currencyByTicker }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg px-3 py-2 text-xs shadow-lg" style={{ background: "white", border: "1px solid #e5e5e5" }}>
      <div className="font-semibold mb-1 opacity-70">{label}</div>
      {payload.map((p, i) => {
        let val;
        if (p.value == null) val = "—";
        else if (unit === "percent") val = fmtPercent(p.value);
        else if (unit === "ratiox")  val = fmtRatio(p.value, 1, "x");
        else if (unit === "money")   val = fmtMoney(p.value, currencyByTicker?.[p.dataKey] || "USD");
        else if (unit === "number")  val = fmtNumber(p.value);
        else val = p.value;
        return (
          <div key={i} className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ background: p.color || p.fill }} />
            <span className="font-medium">{p.name || p.dataKey}</span>
            <span className="ml-auto tabular-nums">{val}</span>
          </div>
        );
      })}
    </div>
  );
}

function axisFmt(unit) {
  if (unit === "percent") return v => `${(v * 100).toFixed(0)}%`;
  if (unit === "ratiox")  return v => `${v}x`;
  if (unit === "money" || unit === "number") return v => {
    const a = Math.abs(v);
    if (a >= 1e12) return (v/1e12).toFixed(0)+"T";
    if (a >= 1e9)  return (v/1e9).toFixed(0)+"B";
    if (a >= 1e6)  return (v/1e6).toFixed(0)+"M";
    if (a >= 1e3)  return (v/1e3).toFixed(0)+"K";
    return String(v);
  };
  return v => v;
}

// SVG Sankey for one stock's income-statement flow. Lightweight, no library.
// Lays nodes out in columns by depth; link thickness ∝ value.
function MoneyFlowSankey({ flow, usd }) {
  const W = 320, H = 300, PAD = 8;
  const cur = usd ? "USD" : flow.currency;

  if (!flow.hasData) {
    return (
      <div className="rounded-2xl p-5 flex flex-col" style={{ background: "white", border: "1px solid #ececec" }}>
        <div className="flex items-center gap-2 mb-3">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: flow.color }} />
          <h4 className="font-semibold text-sm">{flow.ticker}</h4>
        </div>
        <div className="flex-1 flex items-center justify-center text-xs opacity-40 py-12">
          Not enough income-statement data to chart the flow.
        </div>
      </div>
    );
  }

  const { nodes, links } = flow.sankey;

  // Assign each node a column (depth) via longest path from a root.
  const depth = nodes.map(() => 0);
  const outLinks = nodes.map(() => []);
  const inLinks = nodes.map(() => []);
  links.forEach(l => { outLinks[l.source].push(l); inLinks[l.target].push(l); });
  // iterate to stabilize depths
  for (let iter = 0; iter < nodes.length; iter++) {
    links.forEach(l => { if (depth[l.target] < depth[l.source] + 1) depth[l.target] = depth[l.source] + 1; });
  }
  const maxDepth = Math.max(...depth, 0);

  // Node total value = max(sum in, sum out)
  const nodeValue = nodes.map((_, i) => {
    const inSum = inLinks[i].reduce((a, l) => a + l.value, 0);
    const outSum = outLinks[i].reduce((a, l) => a + l.value, 0);
    return Math.max(inSum, outSum);
  });

  // Group nodes by column, lay out vertically proportional to value
  const cols = {};
  nodes.forEach((n, i) => { (cols[depth[i]] = cols[depth[i]] || []).push(i); });
  const colX = d => PAD + (maxDepth === 0 ? 0 : (d / maxDepth) * (W - 2 * PAD - 80));
  const NODE_W = 12;

  const totalForScale = Math.max(...Object.values(cols).map(idxs => idxs.reduce((a, i) => a + nodeValue[i], 0)), 1);
  const scaleY = (H - 2 * PAD) / totalForScale;

  const nodePos = {};
  Object.entries(cols).forEach(([d, idxs]) => {
    idxs.sort((a, b) => nodeValue[b] - nodeValue[a]);
    let y = PAD;
    idxs.forEach(i => {
      const h = Math.max(nodeValue[i] * scaleY, 2);
      nodePos[i] = { x: colX(+d), y, h };
      y += h + 10;
    });
  });

  const kindColor = {
    root: flow.color, mid: flow.color, profit: "#15803d", cost: "#d4d4d4",
  };

  // Build link ribbons; track running offsets at each node side
  const outOff = nodes.map(() => 0);
  const inOff = nodes.map(() => 0);
  const ribbons = links.map((l, li) => {
    const s = nodePos[l.source], t = nodePos[l.target];
    if (!s || !t) return null;
    const lh = Math.max(l.value * scaleY, 1);
    const sy = s.y + outOff[l.source]; outOff[l.source] += lh;
    const ty = t.y + inOff[l.target]; inOff[l.target] += lh;
    const x1 = s.x + NODE_W, x2 = t.x;
    const xm = (x1 + x2) / 2;
    const tnode = nodes[l.target];
    const col = kindColor[tnode.kind] || flow.color;
    const d = `M${x1},${sy} C${xm},${sy} ${xm},${ty} ${x2},${ty} L${x2},${ty+lh} C${xm},${ty+lh} ${xm},${sy+lh} ${x1},${sy+lh} Z`;
    return <path key={li} d={d} fill={col} opacity={0.28} />;
  });

  return (
    <div className="rounded-2xl p-5" style={{ background: "white", border: "1px solid #ececec" }}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: flow.color }} />
          <h4 className="font-semibold text-sm">{flow.ticker}</h4>
        </div>
        <span className="text-[10px] opacity-50">Revenue {fmtMoney(flow.revenue, cur)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ overflow: "visible" }}>
        {ribbons}
        {nodes.map((n, i) => {
          const p = nodePos[i]; if (!p) return null;
          const labelLeft = depth[i] >= maxDepth;
          return (
            <g key={i}>
              <rect x={p.x} y={p.y} width={NODE_W} height={p.h} rx={2} fill={kindColor[n.kind] || flow.color} />
              <text
                x={labelLeft ? p.x - 5 : p.x + NODE_W + 5}
                y={p.y + p.h / 2}
                textAnchor={labelLeft ? "end" : "start"}
                dominantBaseline="middle"
                style={{ fontSize: 9, fill: "#525252" }}>
                {n.name}
                <tspan style={{ fill: "#a3a3a3" }}> {fmtMoney(nodeValue[i], cur)}</tspan>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function CompareChart({ chart, stocks, usd }) {
  const colorByTicker = {};
  const currencyByTicker = {};
  stocks.forEach(s => { colorByTicker[s.ticker] = s.color; currencyByTicker[s.ticker] = usd ? "USD" : s.currency; });
  const tickers = stocks.map(s => s.ticker);
  const yfmt = axisFmt(chart.unit);

  // When in USD mode, money values are already converted — single currency, no warning.
  const moneyMixed = chart.unit === "money" && !usd &&
    new Set(stocks.map(s => s.currency)).size > 1;

  let inner = null;

  if (chart.type === "line") {
    inner = (
      <LineChart data={chart.rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="2 4" stroke="#f0f0ec" vertical={false} />
        <XAxis dataKey="period" tick={{ fontSize: 10, fill: "#a3a3a3" }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={20} />
        <YAxis tick={{ fontSize: 10, fill: "#a3a3a3" }} tickLine={false} axisLine={false} tickFormatter={yfmt} width={44} />
        <Tooltip content={<CompareTooltip unit={chart.unit} currencyByTicker={currencyByTicker} />} />
        <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
        {tickers.map(tk => (
          <Line key={tk} type="monotone" dataKey={tk} stroke={colorByTicker[tk]} strokeWidth={2} dot={false} connectNulls activeDot={{ r: 3 }} />
        ))}
      </LineChart>
    );
  } else if (chart.type === "bar-grouped") {
    inner = (
      <BarChart data={chart.rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="2 4" stroke="#f0f0ec" vertical={false} />
        <XAxis dataKey="period" tick={{ fontSize: 10, fill: "#a3a3a3" }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
        <YAxis tick={{ fontSize: 10, fill: "#a3a3a3" }} tickLine={false} axisLine={false} tickFormatter={yfmt} width={44} />
        <Tooltip content={<CompareTooltip unit={chart.unit} currencyByTicker={currencyByTicker} />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
        <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
        {tickers.map(tk => (
          <Bar key={tk} dataKey={tk} fill={colorByTicker[tk]} radius={[2,2,0,0]} maxBarSize={28} />
        ))}
      </BarChart>
    );
  } else if (chart.type === "bar-stacked") {
    const keyLabels = { shortTermDebt: "Short-Term Debt", longTermDebt: "Long-Term Debt" };
    const keyColors = { shortTermDebt: "#f59e0b", longTermDebt: "#7c3aed" };
    inner = (
      <BarChart data={chart.rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="2 4" stroke="#f0f0ec" vertical={false} />
        <XAxis dataKey="ticker" tick={{ fontSize: 11, fill: "#525252" }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fontSize: 10, fill: "#a3a3a3" }} tickLine={false} axisLine={false} tickFormatter={yfmt} width={44} />
        <Tooltip cursor={{ fill: "rgba(0,0,0,0.03)" }} />
        <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
        {chart.keys.map(k => (
          <Bar key={k} dataKey={k} name={keyLabels[k] || k} stackId="a" fill={keyColors[k]} radius={[2,2,0,0]} maxBarSize={48} />
        ))}
      </BarChart>
    );
  } else if (chart.type === "bar-multi") {
    // Multiple named metrics per stock (grouped). chart.keys = [{key,label,color}]
    inner = (
      <BarChart data={chart.rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="2 4" stroke="#f0f0ec" vertical={false} />
        <XAxis dataKey="ticker" tick={{ fontSize: 11, fill: "#525252" }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fontSize: 10, fill: "#a3a3a3" }} tickLine={false} axisLine={false} tickFormatter={yfmt} width={44} />
        <Tooltip cursor={{ fill: "rgba(0,0,0,0.03)" }} />
        <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
        {chart.keys.map(k => (
          <Bar key={k.key} dataKey={k.key} name={k.label} fill={k.color} radius={[2,2,0,0]} maxBarSize={32} />
        ))}
      </BarChart>
    );
  } else if (chart.type === "bar-single") {
    inner = (
      <BarChart data={chart.rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="2 4" stroke="#f0f0ec" vertical={false} />
        <XAxis dataKey="ticker" tick={{ fontSize: 11, fill: "#525252" }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fontSize: 10, fill: "#a3a3a3" }} tickLine={false} axisLine={false} tickFormatter={yfmt} width={44} />
        <Tooltip cursor={{ fill: "rgba(0,0,0,0.03)" }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const v = payload[0].value;
            const val = v == null ? "—" : chart.unit === "percent" ? fmtPercent(v) : chart.unit === "ratiox" ? fmtRatio(v,1,"x") : chart.unit === "money" ? fmtMoney(v, usd ? "USD" : "USD") : v;
            return <div className="rounded-lg px-3 py-2 text-xs shadow-lg" style={{ background:"white", border:"1px solid #e5e5e5" }}><span className="font-semibold">{label}</span>: {val}</div>;
          }} />
        <Bar dataKey="value" radius={[3,3,0,0]} maxBarSize={56}>
          {chart.rows.map((r, i) => <Cell key={i} fill={colorByTicker[r.ticker] || "#1a1a1a"} />)}
        </Bar>
      </BarChart>
    );
  }

  return (
    <div className="rounded-2xl p-5" style={{ background: "white", border: "1px solid #ececec" }}>
      <div className="flex items-baseline justify-between mb-3 gap-2">
        <h4 className="font-semibold text-sm">{chart.title}{usd && chart.unit === "money" ? " · USD" : ""}</h4>
        {chart.note && <span className="text-[10px] opacity-50 text-right max-w-[50%]">{chart.note}</span>}
      </div>
      <ResponsiveContainer width="100%" height={260}>{inner}</ResponsiveContainer>
      {moneyMixed && (
        <p className="text-[10px] opacity-50 mt-2 flex items-center gap-1">
          <AlertCircle size={9} /> Stocks use different currencies — turn on USD to compare absolute values, or read shapes/trends only.
        </p>
      )}
    </div>
  );
}

function CompareTable({ table, stocks, usd }) {
  const slots = table.slots || ["Latest"];
  const multi = slots.length > 1;
  const dispCur = s => (usd ? "USD" : s.currency);

  // Best value per metric (compared on the "Latest" slot only)
  function bestTicker(metric) {
    if (metric.higherBetter === undefined) return null;
    let best = null, bestVal = null;
    for (const s of stocks) {
      const v = table.data?.[s.ticker]?.[metric.label]?.["Latest"];
      if (v == null || isNaN(v)) continue;
      if (bestVal == null || (metric.higherBetter ? v > bestVal : v < bestVal)) {
        bestVal = v; best = s.ticker;
      }
    }
    return best;
  }

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "white", border: "1px solid #ececec" }}>
      <div className="px-5 py-3 border-b" style={{ borderColor: "#f0f0ec" }}>
        <h4 className="font-semibold text-sm">{table.title}</h4>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "#fafaf7" }}>
              <th className="text-left px-5 py-2.5 font-medium text-xs opacity-50 tracking-wide sticky left-0" style={{ background: "#fafaf7" }}>Metric</th>
              {stocks.map(s => (
                <th key={s.id} colSpan={multi ? slots.length : 1} className="text-right px-4 py-2 font-semibold text-xs whitespace-nowrap border-l" style={{ borderColor: "#f0f0ec" }}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                    {s.ticker}
                  </span>
                  {usd && <span className="ml-1 text-[9px] opacity-40 font-normal">USD</span>}
                </th>
              ))}
            </tr>
            {multi && (
              <tr style={{ background: "#fafaf7" }}>
                <th className="sticky left-0" style={{ background: "#fafaf7" }}></th>
                {stocks.map(s => (
                  slots.map((slot, si) => {
                    // show the actual period label for this stock+slot when available
                    const pl = table.periodLabels?.[s.ticker];
                    const isAnnual = table.metrics?.some(m => m.scale === "a");
                    const arr = pl ? (isAnnual ? pl.a : pl.q) : null;
                    const lbl = arr && arr[si] ? arr[si] : slot;
                    return (
                      <th key={s.id+slot} className="text-right px-4 pb-2 text-[9px] font-medium opacity-40 whitespace-nowrap border-l" style={{ borderColor: si === 0 ? "#f0f0ec" : "transparent" }}>{lbl}</th>
                    );
                  })
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {table.metrics.map((metric, ri) => {
              const winner = bestTicker(metric);
              return (
                <tr key={metric.label} style={{ borderTop: ri === 0 ? "none" : "1px solid #f5f5f2" }}>
                  <td className="px-5 py-2.5 text-xs opacity-70 sticky left-0 whitespace-nowrap" style={{ background: "white" }}>{metric.label}</td>
                  {stocks.map(s => (
                    slots.map((slot, si) => {
                      const v = table.data?.[s.ticker]?.[metric.label]?.[slot];
                      const isWin = !multi || slot === "Latest" ? (winner && s.ticker === winner) : false;
                      const isLatest = slot === "Latest";
                      return (
                        <td key={s.id+slot} className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap border-l"
                          style={{
                            borderColor: si === 0 ? "#f5f5f2" : "transparent",
                            fontWeight: isWin ? 700 : 400,
                            color: isWin ? "#15803d" : (isLatest ? "#1a1a1a" : "#a3a3a3"),
                          }}>
                          {formatCellValue(v, metric.fmt, dispCur(s))}
                        </td>
                      );
                    })
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddStockModal({ onClose, onAdd, existingCount }) {
  const [step, setStep] = useState("paste");   // paste → confirm
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [marketTicker, setMarketTicker] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [scaleFactor, setScaleFactor] = useState(1);
  const [pasteText, setPasteText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState("");

  const doParse = () => {
    setError("");
    if (!ticker.trim()) { setError("Enter a ticker symbol."); return; }
    const result = parseFinancials(pasteText);
    const metricCount = Object.keys(result.metrics).length;
    if (metricCount === 0) {
      setError(result.warnings[0] || "No financial data recognized. Paste the full statements.");
      return;
    }
    setParsed(result);
    setStep("confirm");
  };

  const doAdd = () => {
    onAdd({
      ticker: ticker.trim().toUpperCase(),
      name: name.trim(),
      marketTicker: marketTicker.trim() || ticker.trim().toUpperCase(),
      currency, scaleFactor, parsed,
    });
  };

  const metricCount = parsed ? Object.keys(parsed.metrics).length : 0;
  const qCount = parsed ? parsed.periods.quarterly.length : 0;
  const yCount = parsed ? parsed.periods.annual.length : 0;

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-2xl rounded-2xl p-6 fade-in max-h-[90vh] overflow-y-auto" style={{ background: "white" }}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-serif-h text-xl font-semibold">Add a stock to compare</h3>
          <button onClick={onClose} className="p-1 opacity-50 hover:opacity-100"><X size={16} /></button>
        </div>

        {step === "paste" && (
          <>
            <p className="text-sm opacity-60 mb-4">Paste the financial statements, then tell us the ticker and currency. No AI — the data is parsed instantly and saved to your library for reuse.</p>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-xs font-semibold block mb-1">Ticker symbol *</label>
                <input value={ticker} onChange={e => setTicker(e.target.value)} placeholder="e.g. MU, SK Hynix" className="w-full text-sm px-3 py-2 rounded-lg focus:outline-none" style={{ background: "#fafaf7", border: "1px solid #e5e5e5" }} />
              </div>
              <div>
                <label className="text-xs font-semibold block mb-1">Company name (optional)</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Micron" className="w-full text-sm px-3 py-2 rounded-lg focus:outline-none" style={{ background: "#fafaf7", border: "1px solid #e5e5e5" }} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-xs font-semibold block mb-1">Market ticker (for live price)</label>
                <input value={marketTicker} onChange={e => setMarketTicker(e.target.value)} placeholder="e.g. MU or KR:000660" className="w-full text-sm px-3 py-2 rounded-lg focus:outline-none" style={{ background: "#fafaf7", border: "1px solid #e5e5e5" }} />
                <p className="text-[10px] opacity-40 mt-1">US: just the symbol (MU). Non-US: market-prefixed (KR:000660, JP:8035). Leave blank to use the ticker above.</p>
              </div>
              <div>
                <label className="text-xs font-semibold block mb-1">Currency of this data *</label>
                <select value={currency} onChange={e => setCurrency(e.target.value)} className="w-full text-sm px-3 py-2 rounded-lg focus:outline-none" style={{ background: "#fafaf7", border: "1px solid #e5e5e5" }}>
                  {Object.values(CURRENCIES).map(c => (
                    <option key={c.code} value={c.code}>{c.symbol} {c.name} ({c.code})</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mb-3">
              <label className="text-xs font-semibold block mb-1">What were the numbers originally in?</label>
              <select value={scaleFactor} onChange={e => setScaleFactor(Number(e.target.value))} className="w-full text-sm px-3 py-2 rounded-lg focus:outline-none" style={{ background: "#fafaf7", border: "1px solid #e5e5e5" }}>
                {SCALE_OPTIONS.map(o => (
                  <option key={o.factor} value={o.factor}>{o.label}</option>
                ))}
              </select>
              <p className="text-[10px] opacity-40 mt-1">Your pasted numbers are usually abbreviated. If revenue of $41,456 really means $41.456 billion, choose Millions. This rescales every money value so comparisons and USD conversion are correct.</p>
            </div>
            <div className="mb-3">
              <label className="text-xs font-semibold block mb-1">Financial data</label>
              <p className="text-[11px] opacity-50 mb-2">Copy the Income Statement, Balance Sheet, Cash Flow, and Key Ratios tables from your data source and paste them all here (one after another is fine).</p>
              <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={8}
                placeholder="Paste financial statement rows here…"
                className="w-full text-xs px-3 py-2 rounded-lg focus:outline-none font-mono" style={{ background: "#fafaf7", border: "1px solid #e5e5e5" }} />
            </div>
            {error && <div className="text-xs px-3 py-2 rounded-lg mb-3" style={{ background: "#fee2e2", color: "#991b1b" }}>{error}</div>}
            <div className="flex gap-2">
              <button onClick={doParse} className="flex-1 py-2 rounded-md text-white text-sm font-medium" style={{ background: "#1a1a1a" }}>Parse data</button>
              <button onClick={onClose} className="px-4 py-2 rounded-md text-sm" style={{ background: "#f0f0ec" }}>Cancel</button>
            </div>
          </>
        )}

        {step === "confirm" && parsed && (
          <>
            <div className="rounded-xl p-4 mb-4 mt-3" style={{ background: "#dcfce7" }}>
              <div className="flex items-center gap-2 mb-2"><Check size={14} style={{ color: "#166534" }} /><span className="text-sm font-semibold" style={{ color: "#166534" }}>Parsed successfully</span></div>
              <div className="text-xs space-y-1" style={{ color: "#166534" }}>
                <div>Recognized <b>{metricCount}</b> financial metrics</div>
                <div><b>{qCount}</b> quarters · <b>{yCount}</b> annual periods</div>
                <div>Ticker: <b>{ticker.toUpperCase()}</b> · Price ticker: <b>{marketTicker.trim() || ticker.toUpperCase()}</b> · Currency: <b>{currency}</b></div>
                <div>Scale: <b>{(SCALE_OPTIONS.find(o => o.factor === scaleFactor) || {}).label || "As-is"}</b></div>
              </div>
            </div>
            {parsed.warnings.length > 0 && (
              <div className="text-[11px] px-3 py-2 rounded-lg mb-3" style={{ background: "#fef3c7", color: "#92400e" }}>
                {parsed.warnings.map((w, i) => <div key={i}>{w}</div>)}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={doAdd} className="flex-1 py-2 rounded-md text-white text-sm font-medium" style={{ background: "#1a1a1a" }}>Add to comparison</button>
              <button onClick={() => setStep("paste")} className="px-4 py-2 rounded-md text-sm" style={{ background: "#f0f0ec" }}>Back</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StockLibraryModal({ stocks, activeGroup, onClose, onAddToGroup, onRemoveFromGroup, onDeleteStock, onPasteNew }) {
  const inGroup = id => activeGroup && (activeGroup.stockIds || []).includes(id);
  const groupFull = activeGroup && (activeGroup.stockIds || []).length >= 5;

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-2xl rounded-2xl p-6 fade-in max-h-[90vh] overflow-y-auto" style={{ background: "white" }}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-serif-h text-xl font-semibold">Your stock library</h3>
          <button onClick={onClose} className="p-1 opacity-50 hover:opacity-100"><X size={16} /></button>
        </div>
        <p className="text-sm opacity-60 mb-4">
          Financial data you've already pasted. Add any of them to {activeGroup ? <>the group <b>{activeGroup.name}</b></> : "a group"} without re-entering data.
        </p>

        {stocks.length === 0 ? (
          <div className="rounded-xl p-8 text-center" style={{ background: "#fafaf7", border: "1px dashed #d4d4d4" }}>
            <Database size={28} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm opacity-60 mb-3">No saved stocks yet.</p>
            <button onClick={onPasteNew} className="text-sm px-4 py-2 rounded-lg text-white font-medium" style={{ background: "#1a1a1a" }}>
              <Plus size={14} className="inline mr-1" /> Paste a new stock
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-2 mb-4">
              {stocks.map(s => {
                const here = inGroup(s.id);
                const metricCount = s.parsed ? Object.keys(s.parsed.metrics || {}).length : 0;
                const qCount = s.parsed?.periods?.quarterly?.length || 0;
                return (
                  <div key={s.id} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: "#fafaf7", border: "1px solid #ececec" }}>
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: s.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{s.ticker}</span>
                        {s.name && <span className="text-xs opacity-50 truncate">{s.name}</span>}
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "#e0f2fe", color: "#0369a1" }}>{s.currency}</span>
                      </div>
                      <div className="text-[11px] opacity-40">{metricCount} metrics · {qCount} quarters{s.marketTicker && s.marketTicker !== s.ticker ? ` · price: ${s.marketTicker}` : ""}</div>
                    </div>
                    {activeGroup && (
                      here ? (
                        <button onClick={() => onRemoveFromGroup(s.id)} className="text-xs px-3 py-1.5 rounded-lg font-medium flex items-center gap-1" style={{ background: "#dcfce7", color: "#166534" }}>
                          <Check size={12} /> In group
                        </button>
                      ) : (
                        <button onClick={() => onAddToGroup(s.id)} disabled={groupFull} className="text-xs px-3 py-1.5 rounded-lg font-medium flex items-center gap-1 disabled:opacity-40" style={{ background: "#1a1a1a", color: "white" }}>
                          <Plus size={12} /> Add
                        </button>
                      )
                    )}
                    <button onClick={() => onDeleteStock(s.id)} title="Delete from library permanently" className="p-1.5 opacity-40 hover:opacity-100" style={{ color: "#dc2626" }}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
            {groupFull && <p className="text-[11px] mb-3 px-3 py-2 rounded-lg" style={{ background: "#fef3c7", color: "#92400e" }}>This group is full (5 stocks). Remove one to add another.</p>}
            <button onClick={onPasteNew} className="w-full text-sm px-4 py-2 rounded-lg font-medium" style={{ background: "#f0f0ec" }}>
              <Plus size={14} className="inline mr-1" /> Paste a new stock instead
            </button>
          </>
        )}
      </div>
    </div>
  );
}

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

  // ── Price Alerts state ──────────────────────────────────────────────────────
  const [alerts, setAlerts] = useState([]);
  const [userEmail, setUserEmail] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [emailSaved, setEmailSaved] = useState(false);
  const [newAlertTicker, setNewAlertTicker] = useState("");
  const [newAlertPrice,  setNewAlertPrice]  = useState("");
  const [newAlertNotes,  setNewAlertNotes]  = useState("");
  const [alertError, setAlertError] = useState(null);
  const [creatingAlert, setCreatingAlert] = useState(false);

  // ── Catchup state ───────────────────────────────────────────────────────────
  const [catchupCards, setCatchupCards] = useState([]);
  const [showNewCatchup, setShowNewCatchup] = useState(false);
  const [cuName, setCuName] = useState("");
  const [cuType, setCuType] = useState("stocks");
  const [cuTickers, setCuTickers] = useState("");
  const [cuTopics, setCuTopics] = useState("");
  const [cuKeyInterests, setCuKeyInterests] = useState("");
  const [cuRoutineValue, setCuRoutineValue] = useState(1);
  const [cuRoutineUnit, setCuRoutineUnit] = useState("week");
  const [cuError, setCuError] = useState(null);
  const [generatingCatchup, setGeneratingCatchup] = useState({});  // { cardId: bool }
  const [openCatchupCards, setOpenCatchupCards] = useState({});    // { cardId: bool }
  const [openCatchupSummaries, setOpenCatchupSummaries] = useState({}); // { cardId_sumId: bool }

  // ── Hawkeye state ───────────────────────────────────────────────────────────
  const [hawkeyeCards, setHawkeyeCards] = useState([]);

  // Compare feature state
  const [compareStocks, setCompareStocks] = useState([]);      // the library (all saved stocks)
  const [compareGroups, setCompareGroups] = useState([]);      // saved named groups
  const [activeGroupId, setActiveGroupId] = useState("");
  const [compareTopic, setCompareTopic] = useState("revenue");
  const [comparePeriods, setComparePeriods] = useState(1);     // 1..3 periods shown
  const [compareUsd, setCompareUsd] = useState(false);         // USD conversion toggle
  const [showAddCompareStock, setShowAddCompareStock] = useState(false);
  const [showStockLibrary, setShowStockLibrary] = useState(false);
  const [compareDeleteStockId, setCompareDeleteStockId] = useState(null);
  const [compareDeleteGroupId, setCompareDeleteGroupId] = useState(null);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newCompareGroupName, setNewCompareGroupName] = useState("");
  const [priceData, setPriceData] = useState({});              // { stockId: {price, fxToUsd, ...} }
  const [loadingPrices, setLoadingPrices] = useState(false);
  const [showNewHawkeye, setShowNewHawkeye] = useState(false);
  const [openHawkeyeCards, setOpenHawkeyeCards] = useState({});
  // Form state
  const [hkName, setHkName] = useState("");
  const [hkSource, setHkSource] = useState("group"); // 'group' | 'custom'
  const [hkGroupRef, setHkGroupRef] = useState(""); // "sector:s1" or "custom:g1"
  const [hkCustomTickers, setHkCustomTickers] = useState("");
  const [hkConditions, setHkConditions] = useState([
    { direction: "gain", thresholdPct: 15, triggerWindowDays: 14, reference: "lowest" }
  ]);
  const [bootstrapStatus, setBootstrapStatus] = useState({});  // { ticker: { bootstrapped, ... } }
  const [hkError, setHkError] = useState(null);

  // v4: per-ticker chart data + UI state for the data status panel
  const [tickerHistoryCache, setTickerHistoryCache] = useState({});      // { ticker: { candles, last_close_ts, bootstrapped } }
  const [expandedTickerChart, setExpandedTickerChart] = useState({});    // { `${cardId}_${ticker}`: true }
  const [runningHawkeyeCheck, setRunningHawkeyeCheck] = useState({});    // { [cardId]: true }
  const [hawkeyeCheckResult, setHawkeyeCheckResult] = useState({});      // { [cardId]: { updated, fired, errors } }

  // v5: model preferences + provider availability + settings modal
  const [modelPrefs, setModelPrefs] = useState({ complex_model: DEFAULT_COMPLEX_MODEL, simple_model: DEFAULT_SIMPLE_MODEL });
  const [availableProviders, setAvailableProviders] = useState({ providers: [] });
  const [providersLoading, setProvidersLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState({ complex_model: DEFAULT_COMPLEX_MODEL, simple_model: DEFAULT_SIMPLE_MODEL });
  const [settingsSaving, setSettingsSaving] = useState(false);

  // New: per-ticker history paste state during create flow
  const [hkHistoryByTicker, setHkHistoryByTicker] = useState({});
  const [hkCurrentPasteTicker, setHkCurrentPasteTicker] = useState("");

  // New: add-condition affordance on existing cards
  const [addingConditionToCard, setAddingConditionToCard] = useState(null);
  const [draftCondition, setDraftCondition] = useState({ direction: "gain", thresholdPct: 10, triggerWindowDays: 14, reference: "lowest" });

  const totalUnread = useMemo(
    () => (state.watchCards || []).reduce((sum, c) => sum + c.matches.filter(m => !m.isRead).length, 0),
    [state.watchCards]
  );

  // Alerts that fired but user hasn't acknowledged (status = 'triggered')
  const triggeredAlerts = useMemo(() => alerts.filter(a => a.status === 'triggered'), [alerts]);
  const activeAlerts    = useMemo(() => alerts.filter(a => a.status === 'active'),    [alerts]);
  const stoppedAlerts   = useMemo(() => alerts.filter(a => a.status === 'stopped'),   [alerts]);

  // Sorted catchup cards: starred first, then overdue, then by created_at desc
  const sortedCatchupCards = useMemo(() => {
    return [...catchupCards].sort((a, b) => {
      if ((b.starred ? 1 : 0) !== (a.starred ? 1 : 0)) return (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
      const aDue = computeDueState(a).status === 'overdue' ? 1 : 0;
      const bDue = computeDueState(b).status === 'overdue' ? 1 : 0;
      if (bDue !== aDue) return bDue - aDue;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [catchupCards]);

  const overdueCount = useMemo(
    () => catchupCards.filter(c => computeDueState(c).status === 'overdue').length,
    [catchupCards]
  );

  // Hawkeye: total unread hits across all enabled cards
  const hawkeyeUnreadCount = useMemo(
    () => hawkeyeCards.reduce((sum, c) => sum + (c.hits || []).filter(h => !h.isRead).length, 0),
    [hawkeyeCards]
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
        const a = await loadAlerts();
        setAlerts(a);
        const em = await loadUserEmail();
        setUserEmail(em);
        setEmailDraft(em);
        const cu = await loadCatchupCards();
        setCatchupCards(cu);
        const hk = await loadHawkeyeCards();
        setHawkeyeCards(hk);
        const allHkTickers = [...new Set((hk || []).flatMap(c => c.tickers || []))];
        if (allHkTickers.length > 0) {
          const status = await loadBootstrapStatus(allHkTickers);
          setBootstrapStatus(status);
        }
        const prefs = await loadModelPrefs();
        setModelPrefs(prefs);
        const cmp = await loadCompareStocks();
        setCompareStocks(cmp);
        const grps = await loadCompareGroups();
        setCompareGroups(grps);
        if (grps.length > 0) setActiveGroupId(grps[0].id);
        setCloudStatus("synced");
      } catch { setCloudStatus("offline"); }
      setHydrated(true);
    })();
  }, []);

  useEffect(() => { if (hydrated) saveState(state); }, [state, hydrated]);

  // v5: lazy-load available model providers shortly after hydration
  useEffect(() => {
    if (!hydrated) return;
    setProvidersLoading(true);
    loadAvailableProviders().then(data => {
      setAvailableProviders(data);
    }).catch(() => {}).finally(() => setProvidersLoading(false));
  }, [hydrated]);

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

  // Refresh alerts from DB every 60s so we see triggered status from the cron job
  useEffect(() => {
    if (!hydrated) return;
    const id = setInterval(() => { loadAlerts().then(setAlerts).catch(() => {}); }, 60_000);
    return () => clearInterval(id);
  }, [hydrated]);

  // Refresh hawkeye cards from DB every 60s
  useEffect(() => {
    if (!hydrated) return;
    const id = setInterval(() => { loadHawkeyeCards().then(setHawkeyeCards).catch(() => {}); }, 60_000);
    return () => clearInterval(id);
  }, [hydrated]);

  // Refresh bootstrap status every 5 min for any unbootstrapped tickers
  useEffect(() => {
    if (!hydrated) return;
    const tickers = [...new Set(hawkeyeCards.flatMap(c => c.tickers || []))];
    const id = setInterval(() => {
      if (tickers.length === 0) return;
      loadBootstrapStatus(tickers).then(s => setBootstrapStatus(prev => ({ ...prev, ...s }))).catch(() => {});
    }, 5 * 60_000);
    return () => clearInterval(id);
  }, [hydrated, hawkeyeCards]);

  // v4: when a Hawkeye card opens, load full candle history for its tickers
  useEffect(() => {
    if (!hydrated) return;
    const openIds = Object.keys(openHawkeyeCards).filter(id => openHawkeyeCards[id]);
    if (openIds.length === 0) return;
    const tickers = new Set();
    openIds.forEach(cid => {
      const card = hawkeyeCards.find(c => c.id === cid);
      (card?.tickers || []).forEach(t => { if (!tickerHistoryCache[t]) tickers.add(t); });
    });
    if (tickers.size === 0) return;
    loadTickerHistory([...tickers]).then(map => {
      setTickerHistoryCache(prev => ({ ...prev, ...map }));
    }).catch(() => {});
  }, [hydrated, openHawkeyeCards, hawkeyeCards, tickerHistoryCache]);

  useEffect(() => {
    if (!hydrated) return;
    const items = Object.entries(newsByTicker).flatMap(([tk, arr]) =>
      arr.map(n => ({ key: `${tk}_${n.id || n.url}`, headline: n.headline }))
    );
    const untagged = items.filter(it => !tagsByNewsKey[it.key]);
    if (!untagged.length) return;
    setTaggingInProgress(true);
    tagNews(untagged, modelPrefs.simple_model).then(tags => setTagsByNewsKey(prev => ({ ...prev, ...tags }))).finally(() => setTaggingInProgress(false));
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
  // Normalize a comma-separated ticker string; returns { valid: [...], invalid: [...] }
  const normalizeTickerList = (raw) => {
    const parts = (raw || "").split(",").map(s => s.trim()).filter(Boolean);
    const valid = [], invalid = [];
    for (const p of parts) {
      const n = normalizeTicker(p);
      if (n) { if (!valid.includes(n)) valid.push(n); }
      else invalid.push(p);
    }
    return { valid, invalid };
  };

  const addTicker = () => {
    const t = normalizeTicker(newTicker);
    if (!t) { if (newTicker.trim()) alert(TICKER_INPUT_HELP); return; }
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
    } else if (confirmDelete.type === "alert") {
      const id = confirmDelete.id;
      setAlerts(prev => prev.filter(a => a.id !== id));
      await deleteAlert(id);
    } else if (confirmDelete.type === "catchup") {
      const id = confirmDelete.id;
      setCatchupCards(prev => prev.filter(c => c.id !== id));
      await deleteCatchupCard(id);
    } else if (confirmDelete.type === "hawkeye") {
      const id = confirmDelete.id;
      setHawkeyeCards(prev => prev.filter(c => c.id !== id));
      await deleteHawkeyeCard(id);
    }
    setConfirmDelete(null);
  };

  const createWatchCard = () => {
    const ticker = normalizeTicker(newCardTicker);
    const keyword = newCardKeyword.trim();
    if (!ticker) { if (newCardTicker.trim()) alert(TICKER_INPUT_HELP); return; }
    if (!keyword) return;
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

  // ── Price Alerts: create / stop / delete / email ───────────────────────────
  const saveEmail = async () => {
    const e = (emailDraft || "").trim();
    if (!e || !/^\S+@\S+\.\S+$/.test(e)) {
      setAlertError("Please enter a valid email address.");
      return;
    }
    await saveUserEmail(e);
    setUserEmail(e);
    setEmailSaved(true);
    setAlertError(null);
    setTimeout(() => setEmailSaved(false), 2000);
  };

  const createPriceAlert = async () => {
    setAlertError(null);
    const tk = normalizeTicker(newAlertTicker);
    const target = parseFloat(newAlertPrice);
    if (!tk) { setAlertError(newAlertTicker.trim() ? TICKER_INPUT_HELP : "Please enter a ticker"); return; }
    if (!target || target <= 0) { setAlertError("Please enter a valid target price"); return; }
    if (!userEmail) { setAlertError("Please set your email above first"); return; }

    setCreatingAlert(true);
    try {
      // Need current price as "start price" — fetch fresh
      let startPrice = quotes[tk]?.c;
      if (!startPrice) {
        const q = await getQuote(tk).catch(() => null);
        startPrice = q?.c;
      }
      if (!startPrice) {
        setAlertError(`Could not fetch current price for ${tk}. Check the ticker symbol.`);
        return;
      }
      const row = await createAlert({ ticker: tk, targetPrice: target, startPrice, notes: newAlertNotes });
      if (row) {
        setAlerts(prev => [row, ...prev]);
        setNewAlertTicker(""); setNewAlertPrice(""); setNewAlertNotes("");
        if (!quotes[tk]) loadTicker(tk);
      } else {
        setAlertError("Failed to create alert. Try again.");
      }
    } finally {
      setCreatingAlert(false);
    }
  };

  const handleStopAlert = async (id) => {
    await stopAlert(id);
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, status: 'stopped' } : a));
  };

  const requestDeleteAlert = (id, ticker) => setConfirmDelete({ type: "alert", id, label: `alert on $${ticker}` });

  // ── Catchup handlers ───────────────────────────────────────────────────────
  const resetCatchupForm = () => {
    setCuName(""); setCuType("stocks"); setCuTickers(""); setCuTopics("");
    setCuKeyInterests(""); setCuRoutineValue(1); setCuRoutineUnit("week");
    setCuError(null); setShowNewCatchup(false);
  };

  const createCatchupCard = async () => {
    setCuError(null);
    if (!cuName.trim()) { setCuError("Please give the card a name"); return; }
    const { valid: tickers, invalid: cuInvalid } = normalizeTickerList(cuTickers);
    if (cuInvalid.length > 0) { setCuError(`Invalid ticker(s): ${cuInvalid.join(", ")}. ${TICKER_INPUT_HELP}`); return; }
    const topics  = cuTopics.split(",").map(s => s.trim()).filter(Boolean);
    if ((cuType === "stocks" || cuType === "stocks_and_topics") && tickers.length === 0) {
      setCuError("Please add at least one ticker"); return;
    }
    if ((cuType === "topics" || cuType === "stocks_and_topics") && topics.length === 0) {
      setCuError("Please add at least one topic"); return;
    }
    const id = "cu_" + Date.now();
    const card = {
      id, name: cuName.trim(), type: cuType,
      tickers, topics, key_interests: cuKeyInterests.trim(),
      routine_value: Number(cuRoutineValue) || 1,
      routine_unit: cuRoutineUnit,
      starred: false, summaries: [], last_run_at: null,
      created_at: new Date().toISOString(),
    };
    await saveCatchupCard(card);
    setCatchupCards(prev => [card, ...prev]);
    // Pre-load price data for new tickers
    tickers.forEach(t => { if (!quotes[t]) loadTicker(t); });
    resetCatchupForm();
  };

  const toggleCatchupCardOpen = (id) =>
    setOpenCatchupCards(prev => ({ ...prev, [id]: !prev[id] }));

  const toggleCatchupSummaryOpen = (cardId, sumId) => {
    const k = `${cardId}_${sumId}`;
    setOpenCatchupSummaries(prev => ({ ...prev, [k]: !prev[k] }));
  };

  const toggleCatchupStar = async (card) => {
    const updated = { ...card, starred: !card.starred };
    setCatchupCards(prev => prev.map(c => c.id === card.id ? updated : c));
    await saveCatchupCard(updated);
  };

  const deleteCatchupSummary = async (cardId, sumId) => {
    const card = catchupCards.find(c => c.id === cardId);
    if (!card) return;
    const updated = { ...card, summaries: card.summaries.filter(s => s.id !== sumId) };
    setCatchupCards(prev => prev.map(c => c.id === cardId ? updated : c));
    await saveCatchupCard(updated);
  };

  const requestDeleteCatchupCard = (cardId, name) =>
    setConfirmDelete({ type: "catchup", id: cardId, label: `"${name}"` });

  // ── Hawkeye handlers ───────────────────────────────────────────────────────
  // Preview of the tickers that will be in the new card, based on current form state
  const hkCandidateTickers = useMemo(() => {
    if (hkSource === "group") {
      if (!hkGroupRef) return [];
      const [kind, gid] = hkGroupRef.split(":");
      const sourceList = kind === "sector" ? state.sectorGroups : state.customGroups;
      const g = sourceList.find(g => g.id === gid);
      return g ? g.tickers : [];
    }
    return normalizeTickerList(hkCustomTickers).valid;
  }, [hkSource, hkGroupRef, hkCustomTickers, state.sectorGroups, state.customGroups]);

  const resetHawkeyeForm = () => {
    setHkName(""); setHkSource("group"); setHkGroupRef(""); setHkCustomTickers("");
    setHkConditions([{ direction: "gain", thresholdPct: 15, triggerWindowDays: 14, reference: "lowest" }]);
    setHkHistoryByTicker({}); setHkCurrentPasteTicker("");
    setHkError(null); setShowNewHawkeye(false);
  };

  const addHkCondition = () => {
    setHkConditions(prev => [...prev, { direction: "gain", thresholdPct: 10, triggerWindowDays: 14, reference: "lowest" }]);
  };
  const removeHkCondition = (i) => setHkConditions(prev => prev.filter((_, idx) => idx !== i));
  const updateHkCondition = (i, key, value) =>
    setHkConditions(prev => prev.map((c, idx) => idx === i ? { ...c, [key]: value } : c));

  const createHawkeyeCard = async () => {
    setHkError(null);
    if (!hkName.trim()) { setHkError("Please give the card a name"); return; }

    let tickers = [];
    let groupId = null;
    let groupName = null;

    if (hkSource === "group") {
      if (!hkGroupRef) { setHkError("Please pick a group"); return; }
      const [kind, gid] = hkGroupRef.split(":");
      const sourceList = kind === "sector" ? state.sectorGroups : state.customGroups;
      const g = sourceList.find(g => g.id === gid);
      if (!g || g.tickers.length === 0) { setHkError("Pick a group that contains at least one ticker"); return; }
      tickers = g.tickers;
      groupId = g.id;
      groupName = g.name;
    } else {
      const { valid: hkValid, invalid: hkInvalid } = normalizeTickerList(hkCustomTickers);
      if (hkInvalid.length > 0) { setHkError(`Invalid ticker(s): ${hkInvalid.join(", ")}. ${TICKER_INPUT_HELP}`); return; }
      tickers = hkValid;
      if (tickers.length === 0) { setHkError("Please add at least one ticker"); return; }
    }

    if (hkConditions.length === 0) { setHkError("Please add at least one condition"); return; }
    for (const c of hkConditions) {
      if (!c.thresholdPct || c.thresholdPct <= 0) { setHkError("All conditions need a positive threshold %"); return; }
      if (!c.triggerWindowDays || c.triggerWindowDays <= 0) { setHkError("All conditions need a positive trigger window"); return; }
    }

    const id = "hk_" + Date.now();
    const card = {
      id, name: hkName.trim(),
      source: hkSource,
      group_id: groupId,
      group_name: groupName || hkName.trim(),
      tickers,
      conditions: hkConditions,
      hits: [],
      enabled: true,
      created_at: new Date().toISOString(),
    };
    await saveHawkeyeCard(card);
    setHawkeyeCards(prev => [card, ...prev]);
    setOpenHawkeyeCards(prev => ({ ...prev, [id]: true }));
    // For tickers the user did NOT paste history for, fall back to server bootstrap
    const tickersWithoutHistory = tickers.filter(t => !hkHistoryByTicker[t]?.saved);
    if (tickersWithoutHistory.length > 0) {
      await registerTickersForBootstrap(tickersWithoutHistory);
    }
    // Refresh bootstrap status for all
    const status = await loadBootstrapStatus(tickers);
    setBootstrapStatus(prev => ({ ...prev, ...status }));
    // Preload quote/news/profile
    tickers.forEach(t => { if (!quotes[t]) loadTicker(t); });
    resetHawkeyeForm();
  };

  const toggleHawkeyeCardOpen = (id) =>
    setOpenHawkeyeCards(prev => ({ ...prev, [id]: !prev[id] }));

  // v4: expand/collapse the inline chart for a specific ticker inside a specific card
  const toggleTickerChartExpand = (cardId, ticker) => {
    const key = `${cardId}_${ticker}`;
    setExpandedTickerChart(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // v4: manually trigger a check for this user's enabled Hawkeye cards
  const runHawkeyeCheckForCard = async (cardId) => {
    setRunningHawkeyeCheck(prev => ({ ...prev, [cardId]: true }));
    setHawkeyeCheckResult(prev => ({ ...prev, [cardId]: null }));
    try {
      const result = await runHawkeyeCheckNow();
      // Refresh cards (might have new hits) and ticker history (might have new candle)
      const fresh = await loadHawkeyeCards();
      setHawkeyeCards(fresh);
      const card = fresh.find(c => c.id === cardId);
      if (card && card.tickers) {
        const newHistory = await loadTickerHistory(card.tickers);
        setTickerHistoryCache(prev => ({ ...prev, ...newHistory }));
      }
      setHawkeyeCheckResult(prev => ({ ...prev, [cardId]: result }));
    } catch (e) {
      setHawkeyeCheckResult(prev => ({ ...prev, [cardId]: { error: e.message || String(e) } }));
    } finally {
      setRunningHawkeyeCheck(prev => ({ ...prev, [cardId]: false }));
    }
  };

  const markHawkeyeHitRead = async (cardId, hitId) => {
    const card = hawkeyeCards.find(c => c.id === cardId);
    if (!card) return;
    const updated = { ...card, hits: card.hits.map(h => h.id === hitId ? { ...h, isRead: true } : h) };
    setHawkeyeCards(prev => prev.map(c => c.id === cardId ? updated : c));
    await saveHawkeyeCard(updated);
  };

  const markAllHawkeyeHitsRead = async (cardId) => {
    const card = hawkeyeCards.find(c => c.id === cardId);
    if (!card) return;
    const updated = { ...card, hits: card.hits.map(h => ({ ...h, isRead: true })) };
    setHawkeyeCards(prev => prev.map(c => c.id === cardId ? updated : c));
    await saveHawkeyeCard(updated);
  };

  // Delete a specific hit — this re-arms the condition so it can fire again
  const deleteHawkeyeHit = async (cardId, hitId) => {
    const card = hawkeyeCards.find(c => c.id === cardId);
    if (!card) return;
    const updated = { ...card, hits: card.hits.filter(h => h.id !== hitId) };
    setHawkeyeCards(prev => prev.map(c => c.id === cardId ? updated : c));
    await saveHawkeyeCard(updated);
  };

  const toggleHawkeyeEnabled = async (card) => {
    const updated = { ...card, enabled: !card.enabled };
    setHawkeyeCards(prev => prev.map(c => c.id === card.id ? updated : c));
    await saveHawkeyeCard(updated);
  };

  const requestDeleteHawkeyeCard = (cardId, name) =>
    setConfirmDelete({ type: "hawkeye", id: cardId, label: `"${name}"` });

  // ── Compare handlers ──────────────────────────────────────────────────────
  // ── Compare: derived active group + its stocks ────────────────────────────
  const activeGroup = useMemo(
    () => compareGroups.find(g => g.id === activeGroupId) || null,
    [compareGroups, activeGroupId]
  );

  const activeStocks = useMemo(() => {
    if (!activeGroup) return [];
    return (activeGroup.stockIds || [])
      .map(id => compareStocks.find(s => s.id === id))
      .filter(Boolean)
      .map(s => {
        const pd = priceData[s.id];
        return {
          ...s,
          fxToUsd: pd?.fxToUsd != null ? pd.fxToUsd : (s.currency === "USD" ? 1 : null),
          livePrice: pd?.price != null ? pd.price : null,
        };
      });
  }, [activeGroup, compareStocks, priceData]);

  // ── Compare: stock library handlers ───────────────────────────────────────
  const addCompareStock = async ({ ticker, name, marketTicker, currency, scaleFactor, parsed }) => {
    const usedColors = new Set(compareStocks.map(s => s.color));
    const color = COMPARE_COLORS.find(c => !usedColors.has(c)) || COMPARE_COLORS[compareStocks.length % COMPARE_COLORS.length];
    const stock = {
      id: "cmp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      ticker, name, marketTicker, currency,
      scaleFactor: scaleFactor || 1,
      quarterOffset: 0,
      parsed, color,
    };
    setCompareStocks(prev => [...prev, stock]);
    setShowAddCompareStock(false);
    await saveCompareStock(stock);
    // Auto-add to the active group (create one if none exists)
    if (activeGroup) {
      if ((activeGroup.stockIds || []).length < 5) await addStockToGroup(stock.id);
    } else {
      await createCompareGroup("My comparison", [stock.id]);
    }
  };

  const removeCompareStockFromLibrary = async (id) => {
    setCompareStocks(prev => prev.filter(s => s.id !== id));
    setCompareGroups(prev => prev.map(g => ({ ...g, stockIds: (g.stockIds || []).filter(x => x !== id) })));
    setCompareDeleteStockId(null);
    await deleteCompareStock(id);   // also strips from groups server-side
  };

  const changeCompareCurrency = async (id, currency) => {
    setCompareStocks(prev => prev.map(s => s.id === id ? { ...s, currency } : s));
    await updateCompareStockCurrency(id, currency);
  };

  const changeCompareScale = async (id, scaleFactor) => {
    setCompareStocks(prev => prev.map(s => s.id === id ? { ...s, scaleFactor } : s));
    await updateCompareStockScale(id, scaleFactor);
  };

  const changeCompareOffset = async (id, quarterOffset) => {
    setCompareStocks(prev => prev.map(s => s.id === id ? { ...s, quarterOffset } : s));
    await updateCompareStockOffset(id, quarterOffset);
  };

  // ── Compare: group handlers ───────────────────────────────────────────────
  const createCompareGroup = async (name, stockIds = []) => {
    const group = {
      id: "grp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      name: name || "Untitled group",
      stockIds,
    };
    setCompareGroups(prev => [...prev, group]);
    setActiveGroupId(group.id);
    setShowNewGroup(false);
    setNewCompareGroupName("");
    await saveCompareGroup(group);
    return group;
  };

  const removeCompareGroup = async (id) => {
    setCompareGroups(prev => {
      const next = prev.filter(g => g.id !== id);
      if (activeGroupId === id) setActiveGroupId(next[0]?.id || "");
      return next;
    });
    setCompareDeleteGroupId(null);
    await deleteCompareGroup(id);   // keeps stocks in library
  };

  const addStockToGroup = async (stockId) => {
    if (!activeGroup) { await createCompareGroup("My comparison", [stockId]); return; }
    if ((activeGroup.stockIds || []).includes(stockId)) return;
    if ((activeGroup.stockIds || []).length >= 5) return;
    const updated = { ...activeGroup, stockIds: [...(activeGroup.stockIds || []), stockId] };
    setCompareGroups(prev => prev.map(g => g.id === updated.id ? updated : g));
    await saveCompareGroup(updated);
  };

  const removeStockFromGroup = async (stockId) => {
    if (!activeGroup) return;
    const updated = { ...activeGroup, stockIds: (activeGroup.stockIds || []).filter(x => x !== stockId) };
    setCompareGroups(prev => prev.map(g => g.id === updated.id ? updated : g));
    await saveCompareGroup(updated);
  };

  // ── Compare: live price + FX refresh ──────────────────────────────────────
  const refreshComparePrices = async (stocksToFetch) => {
    const list = stocksToFetch || activeStocks;
    if (!list || list.length === 0) return;
    setLoadingPrices(true);
    try {
      const results = await Promise.all(list.map(async s => {
        const res = await fetchPriceAndFx(s.marketTicker || s.ticker, s.currency);
        return { id: s.id, res };
      }));
      setPriceData(prev => {
        const next = { ...prev };
        results.forEach(({ id, res }) => { next[id] = res; });
        return next;
      });
    } finally {
      setLoadingPrices(false);
    }
  };

  // Auto-fetch prices when the active group changes (once per group view)
  useEffect(() => {
    if (!hydrated) return;
    if (!activeGroup) return;
    const ids = activeGroup.stockIds || [];
    const missing = ids.filter(id => !priceData[id]);
    if (missing.length === 0) return;
    const toFetch = ids
      .map(id => compareStocks.find(s => s.id === id))
      .filter(Boolean);
    if (toFetch.length > 0) refreshComparePrices(toFetch);
    // eslint-disable-next-line
  }, [activeGroupId, hydrated]);

  const compareBuilt = useMemo(() => {
    if (activeStocks.length === 0) return { charts: [], tables: [] };
    return buildTopic(compareTopic, activeStocks, { periods: comparePeriods, usd: compareUsd });
  }, [compareTopic, activeStocks, comparePeriods, compareUsd]);

  const fxMissing = useMemo(
    () => compareUsd && activeStocks.some(s => s.currency !== "USD" && s.fxToUsd == null),
    [compareUsd, activeStocks]
  );

  // ── History paste handlers ────────────────────────────────────────────────
  const previewPasteForTicker = (ticker, text) => {
    setHkHistoryByTicker(prev => ({
      ...prev,
      [ticker]: { ...(prev[ticker] || {}), paste: text }
    }));
    if (!text.trim()) {
      setHkHistoryByTicker(prev => ({
        ...prev,
        [ticker]: { ...(prev[ticker] || {}), parsed: null, error: null }
      }));
      return;
    }
    const result = parseHistoricalPaste(text);
    setHkHistoryByTicker(prev => ({
      ...prev,
      [ticker]: {
        ...(prev[ticker] || {}),
        parsed: result.ok ? result : null,
        error: result.ok ? null : result.error,
      }
    }));
  };

  const submitPasteForTicker = async (ticker) => {
    const st = hkHistoryByTicker[ticker];
    if (!st || !st.parsed || !st.parsed.ok) return;
    setHkHistoryByTicker(prev => ({
      ...prev,
      [ticker]: { ...prev[ticker], saving: true, error: null }
    }));
    const res = await saveTickerHistory(ticker, st.parsed.candles);
    setHkHistoryByTicker(prev => ({
      ...prev,
      [ticker]: {
        ...prev[ticker],
        saving: false,
        saved: res.ok,
        error: res.ok ? null : res.error,
      }
    }));
    if (res.ok) {
      const status = await loadBootstrapStatus([ticker]);
      setBootstrapStatus(prev => ({ ...prev, ...status }));
    }
  };

  // ── Add condition to existing card ────────────────────────────────────────
  const beginAddCondition = (cardId) => {
    setAddingConditionToCard(cardId);
    setDraftCondition({ direction: "gain", thresholdPct: 10, triggerWindowDays: 14, reference: "lowest" });
  };
  const cancelAddCondition = () => setAddingConditionToCard(null);
  const submitAddCondition = async (cardId) => {
    if (!draftCondition.thresholdPct || draftCondition.thresholdPct <= 0) return;
    if (!draftCondition.triggerWindowDays || draftCondition.triggerWindowDays <= 0) return;
    const card = hawkeyeCards.find(c => c.id === cardId);
    if (!card) return;
    const updated = { ...card, conditions: [...(card.conditions || []), { ...draftCondition }] };
    setHawkeyeCards(prev => prev.map(c => c.id === cardId ? updated : c));
    await saveHawkeyeCard(updated);
    setAddingConditionToCard(null);
  };
  const removeConditionFromCard = async (cardId, conditionIdx) => {
    const card = hawkeyeCards.find(c => c.id === cardId);
    if (!card) return;
    if ((card.conditions || []).length <= 1) return; // keep at least one
    const updated = { ...card, conditions: card.conditions.filter((_, i) => i !== conditionIdx) };
    setHawkeyeCards(prev => prev.map(c => c.id === cardId ? updated : c));
    await saveHawkeyeCard(updated);
  };

  const runCatchupGeneration = async (card) => {
    setGeneratingCatchup(prev => ({ ...prev, [card.id]: true }));
    try {
      // 1. Compute window
      const days = periodToDays(card.routine_value, card.routine_unit);
      const toMs = Date.now();
      const fromMs = toMs - days * 86400000;
      const fromDate = new Date(fromMs).toISOString().slice(0, 10);
      const toDate   = new Date(toMs).toISOString().slice(0, 10);

      // 2. Fetch news per ticker for the window
      const newsByTicker = {};
      const tickers = card.tickers || [];
      const finnhubDays = Math.min(Math.max(days, 1), 30); // finnhub free tier limit
      for (const tk of tickers) {
        try {
          const fresh = await getNews(tk, finnhubDays).catch(() => []);
          const fromSec = fromMs / 1000;
          const toSec   = toMs / 1000;
          newsByTicker[tk] = (fresh || [])
            .filter(n => (n.datetime || 0) >= fromSec && (n.datetime || 0) <= toSec)
            .slice(0, 15);
        } catch {
          newsByTicker[tk] = [];
        }
      }

      // 3. Call the catchup API
      const { briefing, meta } = await generateCatchupBriefing({
        cardName: card.name,
        type: card.type,
        tickers,
        topics: card.topics || [],
        keyInterests: card.key_interests || "",
        routineValue: card.routine_value,
        routineUnit: card.routine_unit,
        fromDate, toDate,
        newsByTicker,
        model: modelPrefs.complex_model,
      });

      // 4. Append to card's summaries, update last_run_at
      const sumId = "sum_" + Date.now();
      const newSummary = {
        id: sumId,
        fromDate, toDate,
        createdAt: new Date().toISOString(),
        briefing, meta,
      };
      const updated = {
        ...card,
        summaries: [newSummary, ...(card.summaries || [])],
        last_run_at: new Date().toISOString(),
      };
      await saveCatchupCard(updated);
      setCatchupCards(prev => prev.map(c => c.id === card.id ? updated : c));
      // Auto-open the new summary so user sees it
      setOpenCatchupCards(prev => ({ ...prev, [card.id]: true }));
      setOpenCatchupSummaries(prev => ({ ...prev, [`${card.id}_${sumId}`]: true }));
    } catch (e) {
      alert("Catchup generation failed: " + (e.message || e));
    } finally {
      setGeneratingCatchup(prev => ({ ...prev, [card.id]: false }));
    }
  };

  // ── Summarize: generate ─────────────────────────────────────────────────────
  const runSummary = async () => {
    const ticker = normalizeTicker(sumTicker);
    if (!ticker) { setSummaryError(sumTicker.trim() ? TICKER_INPUT_HELP : "Please enter a ticker"); return; }
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
        model: modelPrefs.complex_model,
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
                { id: "alerts",    label: "Alerts",    badge: triggeredAlerts.length, badgeColor: "#dc2626" },
                { id: "catchup",   label: "Catchup",   badge: overdueCount, badgeColor: "#dc2626" },
                { id: "hawkeye",   label: "Hawkeye",   badge: hawkeyeUnreadCount, badgeColor: "#7c3aed" },
                { id: "compare",   label: "Compare",   badge: compareGroups.length, badgeColor: "#0369a1" },
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
            <button onClick={() => { setSettingsDraft(modelPrefs); setShowSettings(true); }} className="p-1.5 rounded-full hover:bg-gray-100 transition opacity-60 hover:opacity-100" title="Settings">
              <Settings size={14} />
            </button>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-40" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search news" className="pl-9 pr-3 py-1.5 text-sm rounded-full border focus:outline-none focus:border-gray-900 transition" style={{ borderColor: "#e5e5e5", background: "white", width: 200 }} />
            </div>
          </div>
        </div>
      </header>

      {showSync && <SyncModal onClose={() => setShowSync(false)} />}
      {showSettings && (
        <SettingsModal
          modelPrefs={modelPrefs}
          settingsDraft={settingsDraft}
          setSettingsDraft={setSettingsDraft}
          availableProviders={availableProviders}
          providersLoading={providersLoading}
          settingsSaving={settingsSaving}
          onRefresh={async () => {
            setProvidersLoading(true);
            const data = await loadAvailableProviders(true);
            setAvailableProviders(data);
            setProvidersLoading(false);
          }}
          onSave={async () => {
            setSettingsSaving(true);
            const ok = await saveModelPrefs(settingsDraft.complex_model, settingsDraft.simple_model);
            if (ok) {
              setModelPrefs(settingsDraft);
              setShowSettings(false);
            }
            setSettingsSaving(false);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showAddCompareStock && (
        <AddStockModal
          onClose={() => setShowAddCompareStock(false)}
          onAdd={addCompareStock}
          existingCount={compareStocks.length}
        />
      )}
      {showStockLibrary && (
        <StockLibraryModal
          stocks={compareStocks}
          activeGroup={activeGroup}
          onClose={() => setShowStockLibrary(false)}
          onAddToGroup={addStockToGroup}
          onRemoveFromGroup={removeStockFromGroup}
          onDeleteStock={(id) => setCompareDeleteStockId(id)}
          onPasteNew={() => { setShowStockLibrary(false); setShowAddCompareStock(true); }}
        />
      )}
      {compareDeleteStockId && (
        <ConfirmModal
          title="Delete from library?"
          message="This stock and its pasted financial data will be permanently removed from your library and every group. This cannot be undone."
          onConfirm={() => removeCompareStockFromLibrary(compareDeleteStockId)}
          onCancel={() => setCompareDeleteStockId(null)} />
      )}
      {compareDeleteGroupId && (
        <ConfirmModal
          title="Delete this group?"
          message="The group is removed, but the stocks' financial data stays in your library and can be reused in other groups."
          onConfirm={() => removeCompareGroup(compareDeleteGroupId)}
          onCancel={() => setCompareDeleteGroupId(null)} />
      )}
      {confirmDelete && (
        <ConfirmModal
          title={`Remove ${confirmDelete.label}?`}
          message={
            confirmDelete.type === "ticker"  ? `${confirmDelete.label} will be removed from all groups. Pinned news and watching cards using this ticker are kept.` :
            confirmDelete.type === "group"   ? `The group ${confirmDelete.label} will be deleted. Tickers inside are not deleted — they remain in other groups.` :
            confirmDelete.type === "card"    ? `The watching card ${confirmDelete.label} and all its saved matches will be permanently removed.` :
            confirmDelete.type === "alert"   ? `The ${confirmDelete.label} will be permanently removed.` :
            confirmDelete.type === "catchup" ? `The Catchup card ${confirmDelete.label} and all its past briefings will be permanently removed.` :
            confirmDelete.type === "hawkeye" ? `The Hawkeye card ${confirmDelete.label} and all its fired hits will be permanently removed.` :
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
              <input autoFocus value={newTicker} onChange={e => setNewTicker(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && addTicker()} placeholder="AAPL or HK:0700" className="w-full text-sm focus:outline-none mb-1 font-medium" />
              <div className="flex items-start gap-1 text-[10px] opacity-50 mb-2 leading-snug">
                <Globe size={10} className="flex-shrink-0 mt-0.5" />
                <span>US: just the symbol (AAPL). Other markets: prefix with HK, JP, KR, SH, SZ, TW, IN, LSE, DE — e.g. <span className="font-mono">HK:0700</span>, <span className="font-mono">JP:7203</span>.</span>
              </div>
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
                      <div className="font-semibold text-sm"><TickerLabel symbol={tk} /></div>
                      <div className="text-[11px] opacity-50 truncate">{profiles[tk]?.name || (loadingTicker[tk] ? "Loading…" : "—")}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="text-right">
                      <div className="text-xs font-medium">{p.c ? formatPrice(tk, p.c) : "—"}</div>
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
                    <div className="text-xs tracking-widest uppercase opacity-50 mb-1 flex items-center gap-2">
                      {profile.name || "—"}
                      {tickerMarket(selected) !== "US" && <MarketBadge market={tickerMarket(selected)} size="sm" />}
                    </div>
                    <h2 className="font-serif-h text-5xl font-semibold tracking-tight">{tickerCode(selected)}</h2>
                    {(profile.finnhubIndustry || tickerMarket(selected) !== "US") && <div className="text-xs opacity-50 mt-2">{profile.finnhubIndustry ? `${profile.finnhubIndustry} · ` : ""}{getMarket(selected)?.name || profile.exchange}</div>}
                  </div>
                  <div className="text-right">
                    <div className="font-serif-h text-4xl font-semibold">{quote.c ? formatPrice(selected, quote.c) : "—"}</div>
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
                    <input value={newCardTicker} onChange={e => setNewCardTicker(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && createWatchCard()} placeholder="NVDA or HK:0700" className="w-full text-sm font-semibold px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition" style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
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
                    <input value={sumTicker} onChange={e => setSumTicker(e.target.value.toUpperCase())} placeholder="AMD or JP:7203" className="w-full text-sm font-semibold px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition" style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
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

          {/* ── ALERTS VIEW ── */}
          {view === "alerts" && (
            <section>
              <div className="mb-6">
                <h2 className="font-serif-h text-3xl font-semibold mb-1">Price Alerts</h2>
                <p className="text-sm opacity-60">Get an email when a stock hits your target price. Alerts fire one-time during US market hours (Mon–Fri, 9:30 AM – 4:00 PM ET).</p>
              </div>

              {/* Email setup */}
              <div className="rounded-2xl p-6 mb-6" style={{ background: "white", border: "1px solid #ececec" }}>
                <div className="flex items-center gap-2 mb-3">
                  <Mail size={14} className="opacity-50" />
                  <div className="text-sm font-semibold">Alert email</div>
                  {!userEmail && (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: "#fee2e2", color: "#991b1b" }}>
                      Required
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input type="email" value={emailDraft} onChange={e => setEmailDraft(e.target.value)}
                    placeholder="you@example.com"
                    className="flex-1 text-sm px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition"
                    style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                  <button onClick={saveEmail} disabled={emailDraft === userEmail && !!userEmail}
                    className="px-4 py-2 rounded-lg text-white text-sm font-medium transition disabled:opacity-30 flex items-center gap-1"
                    style={{ background: emailSaved ? "#059669" : "#1a1a1a" }}>
                    {emailSaved ? <><Check size={12} /> Saved</> : "Save"}
                  </button>
                </div>
                {userEmail && (
                  <p className="text-[11px] opacity-50 mt-2">
                    Emails go to <b>{userEmail}</b>. Update anytime — only the saved email receives alerts.
                  </p>
                )}
              </div>

              {/* Alert creator */}
              <div className="rounded-2xl p-6 mb-6" style={{ background: "white", border: "1px solid #ececec" }}>
                <div className="flex items-center gap-2 mb-4">
                  <BellRing size={14} className="opacity-50" />
                  <div className="text-sm font-semibold">New price alert</div>
                </div>
                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-3">
                    <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Ticker</label>
                    <input value={newAlertTicker} onChange={e => setNewAlertTicker(e.target.value.toUpperCase())}
                      onKeyDown={e => e.key === "Enter" && createPriceAlert()}
                      placeholder="AMD or HK:0700"
                      className="w-full text-sm font-semibold px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition"
                      style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                  </div>
                  <div className="col-span-3">
                    <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Target price</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm opacity-50">{(getMarket(normalizeTicker(newAlertTicker) || "")?.currencySymbol) || "$"}</span>
                      <input type="number" step="0.01" value={newAlertPrice} onChange={e => setNewAlertPrice(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && createPriceAlert()}
                        placeholder="200.00"
                        className="w-full text-sm font-semibold pl-7 pr-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition"
                        style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                    </div>
                  </div>
                  <div className="col-span-4">
                    <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Note (optional)</label>
                    <input value={newAlertNotes} onChange={e => setNewAlertNotes(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && createPriceAlert()}
                      placeholder="e.g. Buy zone, Sell trigger"
                      className="w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition"
                      style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                  </div>
                  <div className="col-span-2 flex items-end">
                    <button onClick={createPriceAlert}
                      disabled={creatingAlert || !newAlertTicker.trim() || !newAlertPrice || !userEmail}
                      className="w-full py-2 rounded-lg text-white text-sm font-medium transition disabled:opacity-30 flex items-center justify-center gap-1"
                      style={{ background: "#1a1a1a" }}>
                      {creatingAlert ? <><RefreshCw size={11} className="animate-spin" /></> : <><BellRing size={11} /> Alert</>}
                    </button>
                  </div>
                  {alertError && (
                    <div className="col-span-12 text-xs px-3 py-2 rounded-lg" style={{ background: "#fee2e2", color: "#991b1b" }}>
                      {alertError}
                    </div>
                  )}
                  <p className="col-span-12 text-[11px] opacity-50 mt-1">
                    Crosses either direction — if the price climbs to your target from below, or drops to it from above, you'll get an email.
                  </p>
                  {!isUSTicker(normalizeTicker(newAlertTicker) || "") && newAlertTicker.trim() && (
                    <div className="col-span-12 text-[11px] px-3 py-2 rounded-lg flex items-start gap-1.5" style={{ background: "#fef3c7", color: "#92400e" }}>
                      <Globe size={11} className="flex-shrink-0 mt-0.5" />
                      <span>Email price alerts run during <b>US</b> market hours only, so non-US tickers aren't continuously monitored here. For {tickerMarket(normalizeTicker(newAlertTicker) || "")} stocks, use <b>Hawkeye</b> — it checks once daily after each market's close, which fits international markets better.</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Alert cards: triggered first, then active, then stopped */}
              {alerts.length === 0 ? (
                <div className="rounded-2xl p-12 text-center" style={{ background: "white", border: "1px solid #ececec" }}>
                  <BellRing size={32} className="mx-auto opacity-20 mb-3" />
                  <div className="text-sm opacity-60">No price alerts yet.</div>
                  <div className="text-xs opacity-40 mt-1">Create one above. You'll get an email when the price is hit.</div>
                </div>
              ) : (
                <div className="space-y-3">
                  {[...triggeredAlerts, ...activeAlerts, ...stoppedAlerts].map(a => {
                    const currentPx = quotes[a.ticker]?.c;
                    const isTriggered = a.status === 'triggered';
                    const isActive    = a.status === 'active';
                    const isStopped   = a.status === 'stopped';

                    const borderColor = isTriggered ? "#fca5a5" : isStopped ? "#e5e5e5" : "#ececec";
                    const shadowColor = isTriggered ? "0 0 0 3px #fee2e2" : "none";
                    const opacity     = isStopped ? 0.6 : 1;

                    return (
                      <div key={a.id} className="rounded-2xl p-5 fade-in"
                        style={{ background: "white", border: `1px solid ${borderColor}`, boxShadow: shadowColor, opacity }}>
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-bold px-2 py-0.5 rounded-md inline-flex items-center" style={{ background: "#f0f0ec" }}><TickerLabel symbol={a.ticker} showDollar={true} /></span>
                            <span className="text-[11px] opacity-40">target</span>
                            <span className="text-xs font-bold px-2 py-0.5 rounded-md flex items-center gap-0.5" style={{ background: "#f0f0ec" }}>
                              <DollarSign size={9} className="opacity-60" />{Number(a.target_price).toFixed(2)}
                            </span>
                            {isTriggered && (
                              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "#dc2626", color: "white" }}>
                                <BellRing size={9} /> Triggered
                              </span>
                            )}
                            {isActive && (
                              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "#dcfce7", color: "#166534" }}>
                                <Power size={9} /> Active
                              </span>
                            )}
                            {isStopped && (
                              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: "#f0f0ec", color: "#525252" }}>
                                Stopped
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {isTriggered && (
                              <button onClick={() => handleStopAlert(a.id)}
                                className="text-xs font-medium px-3 py-1 rounded-md transition"
                                style={{ background: "#1a1a1a", color: "white" }}>
                                Mark as Stop
                              </button>
                            )}
                            <button onClick={() => requestDeleteAlert(a.id, a.ticker)}
                              className="p-1.5 rounded-full opacity-40 hover:opacity-100 hover:bg-red-50 transition" style={{ color: "#dc2626" }}>
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>

                        {a.notes && (
                          <p className="text-sm opacity-70 mb-3 italic">"{a.notes}"</p>
                        )}

                        <div className="grid grid-cols-3 gap-3 mb-3">
                          <div className="rounded-lg px-3 py-2" style={{ background: "#fafaf7" }}>
                            <div className="text-[10px] tracking-widest uppercase opacity-40 mb-0.5">Current</div>
                            <div className="text-sm font-semibold">{currentPx ? formatPrice(a.ticker, currentPx) : "—"}</div>
                          </div>
                          <div className="rounded-lg px-3 py-2" style={{ background: "#fafaf7" }}>
                            <div className="text-[10px] tracking-widest uppercase opacity-40 mb-0.5">When set</div>
                            <div className="text-sm font-semibold">{formatPrice(a.ticker, Number(a.start_price))}</div>
                          </div>
                          <div className="rounded-lg px-3 py-2" style={{ background: "#fafaf7" }}>
                            <div className="text-[10px] tracking-widest uppercase opacity-40 mb-0.5">
                              {isTriggered ? "Triggered at" : "Distance"}
                            </div>
                            <div className="text-sm font-semibold">
                              {isTriggered
                                ? formatPrice(a.ticker, Number(a.triggered_price))
                                : currentPx
                                  ? `${(((Number(a.target_price) - currentPx) / currentPx) * 100).toFixed(2)}%`
                                  : "—"}
                            </div>
                          </div>
                        </div>

                        <div className="text-[11px] opacity-50 flex items-center gap-2 flex-wrap">
                          <span>Created {timeSinceText(new Date(a.created_at).getTime())}</span>
                          {isTriggered && a.triggered_at && (
                            <>
                              <span>·</span>
                              <span>Fired {timeSinceText(new Date(a.triggered_at).getTime())}</span>
                            </>
                          )}
                          {isTriggered && (
                            <>
                              <span>·</span>
                              <span>{a.email_sent ? "Email sent" : "Email not sent (no address)"}</span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* ── CATCHUP VIEW ── */}
          {view === "catchup" && (
            <section>
              <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h2 className="font-serif-h text-3xl font-semibold mb-1">Catchup</h2>
                  <p className="text-sm opacity-60 max-w-2xl">Build a recurring habit. Create a card for each topic or group of stocks you care about, then come back on schedule to generate a fresh briefing. Overdue cards get a red ring.</p>
                </div>
                <button onClick={() => setShowNewCatchup(true)}
                  className="px-4 py-2 rounded-lg text-white text-sm font-medium flex items-center gap-1.5 flex-shrink-0"
                  style={{ background: "#1a1a1a" }}>
                  <Plus size={13} /> New card
                </button>
              </div>

              {/* CREATE FORM */}
              {showNewCatchup && (
                <div className="rounded-2xl p-6 mb-6 fade-in" style={{ background: "white", border: "1px solid #ececec" }}>
                  <div className="flex items-center gap-2 mb-4">
                    <BookOpen size={14} className="opacity-50" />
                    <div className="text-sm font-semibold">New Catchup card</div>
                  </div>

                  <div className="grid grid-cols-12 gap-3">
                    {/* Name */}
                    <div className="col-span-12">
                      <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Card name</label>
                      <input value={cuName} onChange={e => setCuName(e.target.value)}
                        placeholder="e.g. AMD CPU 3 days update"
                        className="w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition"
                        style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                    </div>

                    {/* Type */}
                    <div className="col-span-12">
                      <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Type</label>
                      <div className="flex gap-1 flex-wrap">
                        {[
                          { id: "stocks",            label: "Stocks only" },
                          { id: "topics",            label: "Topics only" },
                          { id: "stocks_and_topics", label: "Stocks + Topics" },
                        ].map(t => (
                          <button key={t.id} onClick={() => setCuType(t.id)}
                            className="text-xs px-3 py-2 rounded-lg font-medium transition"
                            style={{ background: cuType === t.id ? "#1a1a1a" : "#f0f0ec", color: cuType === t.id ? "white" : "#1a1a1a" }}>
                            {t.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Tickers */}
                    {(cuType === "stocks" || cuType === "stocks_and_topics") && (
                      <div className="col-span-12">
                        <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Tickers (comma-separated)</label>
                        <input value={cuTickers} onChange={e => setCuTickers(e.target.value.toUpperCase())}
                          placeholder="NVDA, AMD, HK:0700"
                          className="w-full text-sm font-semibold px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition"
                          style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                      </div>
                    )}

                    {/* Topics */}
                    {(cuType === "topics" || cuType === "stocks_and_topics") && (
                      <div className="col-span-12">
                        <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Topics (comma-separated)</label>
                        <input value={cuTopics} onChange={e => setCuTopics(e.target.value)}
                          placeholder="e.g. Data center, AI chips, Inference"
                          className="w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition"
                          style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                      </div>
                    )}

                    {/* Key Interests */}
                    <div className="col-span-12">
                      <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Key interests (optional)</label>
                      <input value={cuKeyInterests} onChange={e => setCuKeyInterests(e.target.value)}
                        placeholder="e.g. Product launches, customer wins, gross margin"
                        className="w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition"
                        style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                    </div>

                    {/* Routine */}
                    <div className="col-span-12">
                      <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Routine</label>
                      <div className="flex items-center gap-2">
                        <span className="text-sm opacity-70">Every</span>
                        <input type="number" min="1" value={cuRoutineValue}
                          onChange={e => setCuRoutineValue(parseInt(e.target.value) || 1)}
                          className="w-20 text-sm font-semibold text-center px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition"
                          style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                        <div className="flex gap-1">
                          {[
                            { id: "day",   label: "day(s)" },
                            { id: "week",  label: "week(s)" },
                            { id: "month", label: "month(s)" },
                          ].map(u => (
                            <button key={u.id} onClick={() => setCuRoutineUnit(u.id)}
                              className="text-xs px-3 py-2 rounded-lg font-medium transition"
                              style={{ background: cuRoutineUnit === u.id ? "#1a1a1a" : "#f0f0ec", color: cuRoutineUnit === u.id ? "white" : "#1a1a1a" }}>
                              {u.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {cuError && (
                      <div className="col-span-12 text-xs px-3 py-2 rounded-lg" style={{ background: "#fee2e2", color: "#991b1b" }}>
                        {cuError}
                      </div>
                    )}

                    <div className="col-span-12 flex items-center justify-between mt-1">
                      <p className="text-[11px] opacity-50">
                        After creating, click "Generate update" to produce your first briefing.
                      </p>
                      <div className="flex gap-2">
                        <button onClick={resetCatchupForm} className="px-4 py-2 rounded-lg text-sm" style={{ background: "#f0f0ec" }}>Cancel</button>
                        <button onClick={createCatchupCard} className="px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ background: "#1a1a1a" }}>
                          Create card
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* CATCHUP CARDS LIST */}
              {sortedCatchupCards.length === 0 && !showNewCatchup ? (
                <div className="rounded-2xl p-12 text-center" style={{ background: "white", border: "1px solid #ececec" }}>
                  <BookOpen size={32} className="mx-auto opacity-20 mb-3" />
                  <div className="text-sm opacity-60">No Catchup cards yet.</div>
                  <div className="text-xs opacity-40 mt-1">Build a routine. Add a card above to get started.</div>
                </div>
              ) : (
                <div className="space-y-4">
                  {sortedCatchupCards.map(card => {
                    const due = computeDueState(card);
                    const isOverdue = due.status === "overdue";
                    const isOpen    = !!openCatchupCards[card.id];
                    const isGenerating = !!generatingCatchup[card.id];
                    const summaries = card.summaries || [];

                    return (
                      <div key={card.id} className="rounded-2xl fade-in overflow-hidden"
                        style={{
                          background: "white",
                          border: isOverdue ? "1px solid #dc2626" : "1px solid #ececec",
                          boxShadow: isOverdue ? "0 0 0 3px #fee2e2" : "none",
                        }}>
                        {/* CARD HEADER */}
                        <div className="p-5 cursor-pointer" onClick={() => toggleCatchupCardOpen(card.id)}>
                          <div className="flex items-start justify-between gap-3 mb-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                {card.starred && (
                                  <Star size={13} fill="#fbbf24" stroke="#fbbf24" className="flex-shrink-0" />
                                )}
                                <h3 className="font-serif-h text-xl font-semibold leading-tight">{card.name}</h3>
                              </div>
                              <div className="flex items-center gap-2 flex-wrap mt-2">
                                <span className="text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full" style={{
                                  background: card.type === "stocks" ? "#dbeafe" : card.type === "topics" ? "#ede9fe" : "#fef3c7",
                                  color:      card.type === "stocks" ? "#1e40af" : card.type === "topics" ? "#6d28d9" : "#92400e",
                                }}>
                                  {card.type === "stocks" ? "Stocks" : card.type === "topics" ? "Topics" : "Stocks + Topics"}
                                </span>
                                {(card.tickers || []).slice(0, 4).map(t => (
                                  <span key={t} className="text-xs font-bold px-2 py-0.5 rounded-md inline-flex items-center" style={{ background: "#f0f0ec" }}><TickerLabel symbol={t} showDollar={true} /></span>
                                ))}
                                {(card.tickers || []).length > 4 && (
                                  <span className="text-[11px] opacity-50">+{card.tickers.length - 4} more</span>
                                )}
                                {(card.topics || []).slice(0, 3).map(t => (
                                  <span key={t} className="text-[11px] px-2 py-0.5 rounded-md italic" style={{ background: "#fafaf7", color: "#525252" }}>{t}</span>
                                ))}
                                {(card.topics || []).length > 3 && (
                                  <span className="text-[11px] opacity-50">+{card.topics.length - 3}</span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button onClick={e => { e.stopPropagation(); toggleCatchupStar(card); }}
                                className="p-1.5 rounded-full opacity-50 hover:opacity-100 hover:bg-gray-100 transition" title="Star">
                                <Star size={14} fill={card.starred ? "#fbbf24" : "none"} stroke={card.starred ? "#fbbf24" : "currentColor"} />
                              </button>
                              <button onClick={e => { e.stopPropagation(); requestDeleteCatchupCard(card.id, card.name); }}
                                className="p-1.5 rounded-full opacity-40 hover:opacity-100 hover:bg-red-50 transition" style={{ color: "#dc2626" }}>
                                <Trash2 size={13} />
                              </button>
                              <button className="p-1.5 rounded-full opacity-40 hover:opacity-100 hover:bg-gray-100 transition">
                                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                            </div>
                          </div>

                          {/* Routine + Due status */}
                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            <div className="flex items-center gap-3 text-[11px] opacity-60">
                              <span className="flex items-center gap-1">
                                <Repeat size={10} /> Every {card.routine_value} {card.routine_unit}{card.routine_value !== 1 ? "s" : ""}
                              </span>
                              <span>·</span>
                              <span>{summaries.length} {summaries.length === 1 ? "briefing" : "briefings"}</span>
                              {card.last_run_at && (
                                <>
                                  <span>·</span>
                                  <span>Last run {timeSinceText(new Date(card.last_run_at).getTime())}</span>
                                </>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-semibold px-2 py-1 rounded-full flex items-center gap-1" style={{
                                background: isOverdue ? "#fee2e2" : due.status === "due-today" ? "#fef3c7" : due.status === "due-soon" ? "#fef3c7" : "#dcfce7",
                                color:      isOverdue ? "#991b1b" : due.status === "due-today" ? "#92400e" : due.status === "due-soon" ? "#92400e" : "#166534",
                              }}>
                                <CalendarClock size={10} />
                                {isOverdue ? `Overdue by ${due.overdueDays}d`
                                  : due.status === "due-today" ? "Due today"
                                  : due.status === "due-soon"  ? `Due in ${due.untilDays}d`
                                  : `Due in ${due.untilDays}d`}
                              </span>
                              <button
                                onClick={e => { e.stopPropagation(); runCatchupGeneration(card); }}
                                disabled={isGenerating}
                                className="text-xs px-3 py-1.5 rounded-lg text-white font-medium flex items-center gap-1.5 disabled:opacity-30 transition"
                                style={{ background: isOverdue ? "#dc2626" : "#1a1a1a" }}>
                                {isGenerating ? <><RefreshCw size={11} className="animate-spin" /> Generating…</> : <><Sparkles size={11} /> Generate update</>}
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* SUMMARIES LIST (first layer) */}
                        {isOpen && (
                          <div className="border-t" style={{ borderColor: "#f0f0ec" }}>
                            {summaries.length === 0 ? (
                              <div className="px-5 py-6 text-center text-xs opacity-40 italic">
                                No briefings yet. Click "Generate update" above to create your first one.
                              </div>
                            ) : (
                              <div className="divide-y" style={{ borderColor: "#f0f0ec" }}>
                                {summaries.map(s => {
                                  const sumKey = `${card.id}_${s.id}`;
                                  const sumOpen = !!openCatchupSummaries[sumKey];
                                  const b = s.briefing || {};
                                  return (
                                    <div key={s.id}>
                                      {/* SUMMARY ROW */}
                                      <div className="px-5 py-3 cursor-pointer hover:bg-gray-50 transition group"
                                        onClick={() => toggleCatchupSummaryOpen(card.id, s.id)}>
                                        <div className="flex items-center justify-between gap-3">
                                          <div className="flex items-center gap-3 min-w-0 flex-1">
                                            {sumOpen ? <ChevronDown size={12} className="opacity-50 flex-shrink-0" /> : <ChevronRight size={12} className="opacity-50 flex-shrink-0" />}
                                            <div className="flex-1 min-w-0">
                                              <div className="text-sm font-medium truncate">
                                                {b.tldr || `Briefing · ${s.fromDate} → ${s.toDate}`}
                                              </div>
                                              <div className="text-[11px] opacity-50 mt-0.5 flex items-center gap-2 flex-wrap">
                                                <span>{s.fromDate} → {s.toDate}</span>
                                                <span>·</span>
                                                <span>Generated {timeSinceText(new Date(s.createdAt).getTime())}</span>
                                                {s.meta?.costUSD != null && (
                                                  <>
                                                    <span>·</span>
                                                    <span>Cost ${s.meta.costUSD.toFixed(4)}</span>
                                                  </>
                                                )}
                                              </div>
                                            </div>
                                          </div>
                                          <button onClick={e => { e.stopPropagation(); deleteCatchupSummary(card.id, s.id); }}
                                            className="p-1 opacity-0 group-hover:opacity-40 hover:opacity-100 transition" style={{ color: "#dc2626" }}>
                                            <X size={12} />
                                          </button>
                                        </div>
                                      </div>

                                      {/* SUMMARY DETAIL (second layer) */}
                                      {sumOpen && (
                                        <div className="px-5 pb-5 pt-1 bg-gray-50 border-t" style={{ borderColor: "#f0f0ec" }}>
                                          {/* Key updates */}
                                          {b.key_updates?.length > 0 && (
                                            <div className="mb-5">
                                              <div className="flex items-center gap-2 mb-3 mt-2">
                                                <Zap size={11} className="opacity-60" />
                                                <span className="text-[11px] font-semibold tracking-widest uppercase opacity-60">Key updates</span>
                                              </div>
                                              <div className="space-y-3">
                                                {b.key_updates.map((u, i) => (
                                                  <div key={i} className="bg-white rounded-xl p-4" style={{ border: "1px solid #ececec" }}>
                                                    <div className="font-serif-h text-base font-bold leading-snug mb-1">{stripTags(u.title || "")}</div>
                                                    <p className="text-sm opacity-70 leading-relaxed mb-2">{stripTags(u.summary || "")}</p>
                                                    <div className="flex flex-wrap gap-1.5">
                                                      {(u.related || []).map(t => (
                                                        <span key={t} className="text-[10px] font-bold px-1.5 py-0.5 rounded-md inline-flex items-center" style={{ background: "#f0f0ec" }}><TickerLabel symbol={t} showDollar={true} badgeSize="xs" /></span>
                                                      ))}
                                                      {(u.sources || []).map((src, j) => (
                                                        <a key={j} href={src.url} target="_blank" rel="noreferrer"
                                                          className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full hover:opacity-80 transition"
                                                          style={{ background: "#f7f7f3", color: "#525252" }}>
                                                          <ExternalLink size={9} /> {src.title || "Source"}
                                                        </a>
                                                      ))}
                                                    </div>
                                                  </div>
                                                ))}
                                              </div>
                                            </div>
                                          )}

                                          {/* Key elements */}
                                          {b.key_elements?.length > 0 && (
                                            <div className="mb-4 bg-white rounded-xl p-4" style={{ border: "1px solid #ececec" }}>
                                              <div className="flex items-center gap-2 mb-2">
                                                <Lightbulb size={11} className="opacity-60" />
                                                <span className="text-[11px] font-semibold tracking-widest uppercase opacity-60">Key elements</span>
                                              </div>
                                              <ul className="space-y-1.5">
                                                {b.key_elements.map((e, i) => (
                                                  <li key={i} className="text-sm opacity-70 leading-relaxed flex gap-2">
                                                    <span className="opacity-40 flex-shrink-0">·</span>
                                                    <span>{stripTags(e)}</span>
                                                  </li>
                                                ))}
                                              </ul>
                                            </div>
                                          )}

                                          {/* What to watch */}
                                          {b.what_to_watch?.length > 0 && (
                                            <div className="mb-4 bg-white rounded-xl p-4" style={{ border: "1px solid #ececec" }}>
                                              <div className="flex items-center gap-2 mb-2">
                                                <ListChecks size={11} className="opacity-60" />
                                                <span className="text-[11px] font-semibold tracking-widest uppercase opacity-60">What to watch</span>
                                              </div>
                                              <ul className="space-y-1.5">
                                                {b.what_to_watch.map((w, i) => (
                                                  <li key={i} className="text-sm opacity-70 leading-relaxed flex gap-2">
                                                    <span className="opacity-40 flex-shrink-0">→</span>
                                                    <span>{stripTags(w)}</span>
                                                  </li>
                                                ))}
                                              </ul>
                                            </div>
                                          )}

                                          {/* Next events */}
                                          {b.next_events?.length > 0 && (
                                            <div className="bg-white rounded-xl p-4" style={{ border: "1px solid #ececec" }}>
                                              <div className="flex items-center gap-2 mb-2">
                                                <Clock size={11} className="opacity-60" />
                                                <span className="text-[11px] font-semibold tracking-widest uppercase opacity-60">Next events</span>
                                              </div>
                                              <div className="space-y-2">
                                                {b.next_events.map((ev, i) => (
                                                  <div key={i} className="flex gap-3 items-start">
                                                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: "#e0f2fe", color: "#0369a1" }}>{stripTags(ev.when || "")}</span>
                                                    <span className="text-sm opacity-70 leading-relaxed">{stripTags(ev.what || "")}</span>
                                                  </div>
                                                ))}
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* ── HAWKEYE VIEW ── */}
          {view === "hawkeye" && (
            <section>
              <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h2 className="font-serif-h text-3xl font-semibold mb-1">Hawkeye</h2>
                  <p className="text-sm opacity-60 max-w-2xl">Set rule-based alerts to catch early breakouts in a group of stocks. No AI — just precise math on closing prices. Checked once daily after US market close.</p>
                </div>
                <button onClick={() => setShowNewHawkeye(true)} className="px-4 py-2 rounded-lg text-white text-sm font-medium flex items-center gap-1.5 flex-shrink-0" style={{ background: "#1a1a1a" }}>
                  <Plus size={13} /> New Hawkeye card
                </button>
              </div>

              {/* CREATE FORM */}
              {showNewHawkeye && (
                <div className="rounded-2xl p-6 mb-6 fade-in" style={{ background: "white", border: "1px solid #ececec" }}>
                  <div className="flex items-center gap-2 mb-4">
                    <Crosshair size={14} className="opacity-50" />
                    <div className="text-sm font-semibold">New Hawkeye card</div>
                  </div>

                  <div className="grid grid-cols-12 gap-3 mb-4">
                    {/* Name */}
                    <div className="col-span-12">
                      <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Card name</label>
                      <input value={hkName} onChange={e => setHkName(e.target.value)} placeholder="e.g. AI Chip breakout watch" className="w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition" style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                    </div>

                    {/* Source */}
                    <div className="col-span-12">
                      <label className="text-[10px] tracking-widest uppercase opacity-50 mb-1 block">Stocks to watch</label>
                      <div className="flex gap-1 mb-2">
                        <button onClick={() => setHkSource("group")} className="text-xs px-3 py-2 rounded-lg font-medium transition" style={{ background: hkSource === "group" ? "#1a1a1a" : "#f0f0ec", color: hkSource === "group" ? "white" : "#1a1a1a" }}>
                          Pick an existing group
                        </button>
                        <button onClick={() => setHkSource("custom")} className="text-xs px-3 py-2 rounded-lg font-medium transition" style={{ background: hkSource === "custom" ? "#1a1a1a" : "#f0f0ec", color: hkSource === "custom" ? "white" : "#1a1a1a" }}>
                          Custom tickers
                        </button>
                      </div>
                      {hkSource === "group" ? (
                        <select value={hkGroupRef} onChange={e => setHkGroupRef(e.target.value)} className="w-full text-sm px-3 py-2 rounded-lg focus:outline-none" style={{ background: "#fafaf7", border: "1px solid #e5e5e5" }}>
                          <option value="">Choose a group…</option>
                          <optgroup label="Sectors">
                            {(state.sectorGroups || []).map(g => (
                              <option key={"sector:" + g.id} value={"sector:" + g.id}>{g.name} ({g.tickers.length})</option>
                            ))}
                          </optgroup>
                          <optgroup label="My Groups">
                            {(state.customGroups || []).map(g => (
                              <option key={"custom:" + g.id} value={"custom:" + g.id}>{g.name} ({g.tickers.length})</option>
                            ))}
                          </optgroup>
                        </select>
                      ) : (
                        <input value={hkCustomTickers} onChange={e => setHkCustomTickers(e.target.value.toUpperCase())} placeholder="NVDA, AMD, HK:0700, JP:7203" className="w-full text-sm font-semibold px-3 py-2 rounded-lg border focus:outline-none focus:border-gray-900 transition" style={{ borderColor: "#e5e5e5", background: "#fafaf7" }} />
                      )}
                    </div>
                  </div>

                  {/* Conditions builder */}
                  <div className="mb-3">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-[10px] tracking-widest uppercase opacity-50">Conditions (any of these will fire)</label>
                      <button onClick={addHkCondition} className="text-[11px] font-medium flex items-center gap-1 opacity-70 hover:opacity-100">
                        <Plus size={11} /> Add condition
                      </button>
                    </div>
                    <div className="space-y-2">
                      {hkConditions.map((c, i) => (
                        <div key={i} className="p-3 rounded-lg" style={{ background: "#fafaf7", border: "1px solid #e5e5e5" }}>
                          <div className="flex items-center gap-2 flex-wrap text-sm">
                            <span className="opacity-60">Trigger when price</span>
                            <select value={c.direction} onChange={e => updateHkCondition(i, "direction", e.target.value)} className="text-xs px-2 py-1 rounded-md font-semibold focus:outline-none" style={{ background: "white", border: "1px solid #e5e5e5" }}>
                              <option value="gain">gains</option>
                              <option value="loss">loses</option>
                            </select>
                            <input type="number" min="1" max="500" value={c.thresholdPct} onChange={e => updateHkCondition(i, "thresholdPct", parseFloat(e.target.value) || 0)} className="w-16 text-xs px-2 py-1 rounded-md font-semibold text-center focus:outline-none" style={{ background: "white", border: "1px solid #e5e5e5" }} />
                            <span className="opacity-60">% within last</span>
                            <input type="number" min="1" max="365" value={c.triggerWindowDays} onChange={e => updateHkCondition(i, "triggerWindowDays", parseInt(e.target.value) || 1)} className="w-16 text-xs px-2 py-1 rounded-md font-semibold text-center focus:outline-none" style={{ background: "white", border: "1px solid #e5e5e5" }} />
                            <span className="opacity-60">day(s), measured from</span>
                            <select value={c.reference} onChange={e => updateHkCondition(i, "reference", e.target.value)} className="text-xs px-2 py-1 rounded-md font-semibold focus:outline-none" style={{ background: "white", border: "1px solid #e5e5e5" }}>
                              <option value="lowest">recent low</option>
                              <option value="highest">recent high</option>
                              <option value="first">start of window</option>
                            </select>
                            {hkConditions.length > 1 && (
                              <button onClick={() => removeHkCondition(i)} className="ml-auto p-1 rounded hover:bg-red-50 transition" style={{ color: "#dc2626" }}>
                                <X size={12} />
                              </button>
                            )}
                          </div>
                          <div className="text-[10px] opacity-50 mt-2 ml-1">
                            Reads: "{describeCondition(c)}"
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* ── Historical data input ── */}
                  {hkCandidateTickers.length > 0 && (
                    <div className="mb-4 mt-2">
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-[10px] tracking-widest uppercase opacity-50">Provide historical data (recommended)</label>
                        <span className="text-[11px] opacity-50">
                          {hkCandidateTickers.filter(t => hkHistoryByTicker[t]?.saved).length} / {hkCandidateTickers.length} loaded
                        </span>
                      </div>
                      <div className="p-3 rounded-lg mb-2 flex items-start gap-2 text-[11px]" style={{ background: "#eef2ff", color: "#3730a3" }}>
                        <ClipboardPaste size={13} className="mt-0.5 flex-shrink-0" />
                        <div>
                          Paste historical OHLC data for each ticker so Hawkeye works immediately. Supports Yahoo Finance, stockanalysis.com, Investing.com, TradingView, or any CSV/TSV with Date and Close columns. Skipped tickers will be bootstrapped automatically over time.
                        </div>
                      </div>

                      {/* Ticker chips — click to select for paste */}
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {hkCandidateTickers.map(t => {
                          const st = hkHistoryByTicker[t];
                          const isSelected = hkCurrentPasteTicker === t;
                          const isDone = st?.saved;
                          return (
                            <button key={t} onClick={() => setHkCurrentPasteTicker(t)}
                              className="text-xs font-bold px-2 py-1 rounded-md transition flex items-center gap-1"
                              style={{
                                background: isDone ? "#dcfce7" : isSelected ? "#1a1a1a" : "#f0f0ec",
                                color:      isDone ? "#166534" : isSelected ? "white" : "#1a1a1a",
                              }}>
                              {isDone && <Check size={10} />}
                              ${t}
                            </button>
                          );
                        })}
                      </div>

                      {/* Paste box for selected ticker */}
                      {hkCurrentPasteTicker && (() => {
                        const st = hkHistoryByTicker[hkCurrentPasteTicker] || {};
                        return (
                          <div className="rounded-lg p-3 fade-in" style={{ background: "#fafaf7", border: "1px solid #e5e5e5" }}>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs font-semibold">
                                Paste history for <span className="font-bold">${hkCurrentPasteTicker}</span>
                              </span>
                              {st.saved && (
                                <span className="text-[10px] font-semibold flex items-center gap-1" style={{ color: "#166534" }}>
                                  <Check size={11} /> Saved
                                </span>
                              )}
                            </div>
                            <textarea
                              value={st.paste || ""}
                              onChange={e => previewPasteForTicker(hkCurrentPasteTicker, e.target.value)}
                              placeholder={"Paste rows from your source. Example:\nDate,Open,High,Low,Close\n2026-05-01,182.0,184.5,181.2,183.7\n..."}
                              rows={6}
                              className="w-full text-xs font-mono px-2 py-2 rounded-md focus:outline-none"
                              style={{ background: "white", border: "1px solid #e5e5e5" }}
                            />
                            {st.parsed && (
                              <div className="mt-2 text-[11px]" style={{ color: "#166534" }}>
                                ✓ Parsed {st.parsed.count} candles, {st.parsed.fromDate} → {st.parsed.toDate}
                                {st.parsed.warnings?.length > 0 && (
                                  <span className="opacity-60"> · {st.parsed.warnings.length} row(s) skipped</span>
                                )}
                              </div>
                            )}
                            {st.error && (
                              <div className="mt-2 text-[11px]" style={{ color: "#991b1b" }}>
                                ✗ {st.error}
                              </div>
                            )}
                            <div className="flex items-center justify-end gap-2 mt-2">
                              <button
                                onClick={() => submitPasteForTicker(hkCurrentPasteTicker)}
                                disabled={!st.parsed || st.saving || st.saved}
                                className="text-xs px-3 py-1.5 rounded-md text-white font-medium transition disabled:opacity-30 flex items-center gap-1"
                                style={{ background: st.saved ? "#059669" : "#1a1a1a" }}>
                                {st.saving ? <><RefreshCw size={11} className="animate-spin" /> Saving</> :
                                 st.saved ? <><Check size={11} /> Saved</> :
                                 <><FileUp size={11} /> Save history</>}
                              </button>
                              {st.saved && (() => {
                                const nextTicker = hkCandidateTickers.find(t => t !== hkCurrentPasteTicker && !hkHistoryByTicker[t]?.saved);
                                if (!nextTicker) return null;
                                return (
                                  <button onClick={() => setHkCurrentPasteTicker(nextTicker)}
                                    className="text-xs px-3 py-1.5 rounded-md font-medium" style={{ background: "#f0f0ec" }}>
                                    Next: ${nextTicker} →
                                  </button>
                                );
                              })()}
                            </div>
                          </div>
                        );
                      })()}

                      {!hkCurrentPasteTicker && (
                        <div className="text-[11px] opacity-50 italic">Click a ticker chip above to paste its historical data.</div>
                      )}
                    </div>
                  )}

                  {hkError && (
                    <div className="text-xs px-3 py-2 rounded-lg mb-3" style={{ background: "#fee2e2", color: "#991b1b" }}>
                      {hkError}
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <p className="text-[11px] opacity-50">
                      Conditions are checked once daily after market close. No AI — pure math on closing prices.
                    </p>
                    <div className="flex gap-2">
                      <button onClick={resetHawkeyeForm} className="px-4 py-2 rounded-lg text-sm" style={{ background: "#f0f0ec" }}>Cancel</button>
                      <button onClick={createHawkeyeCard} className="px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ background: "#1a1a1a" }}>
                        Create card
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* CARDS LIST */}
              {hawkeyeCards.length === 0 && !showNewHawkeye ? (
                <div className="rounded-2xl p-12 text-center" style={{ background: "white", border: "1px solid #ececec" }}>
                  <Crosshair size={32} className="mx-auto opacity-20 mb-3" />
                  <div className="text-sm opacity-60">No Hawkeye cards yet.</div>
                  <div className="text-xs opacity-40 mt-1">Build one to start catching early breakouts.</div>
                </div>
              ) : (
                <div className="space-y-4">
                  {hawkeyeCards.map(card => {
                    const isOpen = !!openHawkeyeCards[card.id];
                    const hits = card.hits || [];
                    const unread = hits.filter(h => !h.isRead).length;
                    const borderColor = unread > 0 ? "#a78bfa" : "#ececec";
                    const shadow = unread > 0 ? "0 0 0 3px #f5f3ff" : "none";

                    return (
                      <div key={card.id} className="rounded-2xl fade-in overflow-hidden" style={{ background: "white", border: `1px solid ${borderColor}`, boxShadow: shadow, opacity: card.enabled ? 1 : 0.6 }}>
                        {/* HEADER */}
                        <div className="p-5 cursor-pointer" onClick={() => toggleHawkeyeCardOpen(card.id)}>
                          <div className="flex items-start justify-between gap-3 mb-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <Crosshair size={14} style={{ color: "#7c3aed" }} className="flex-shrink-0" />
                                <h3 className="font-serif-h text-xl font-semibold leading-tight">{card.name}</h3>
                                {!card.enabled && (
                                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: "#f0f0ec", color: "#525252" }}>
                                    Paused
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 flex-wrap mt-2">
                                {card.source === "group" && card.group_name && (
                                  <span className="text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full" style={{ background: "#ede9fe", color: "#6d28d9" }}>
                                    Group · {card.group_name}
                                  </span>
                                )}
                                {(card.tickers || []).slice(0, 6).map(t => (
                                  <span key={t} className="text-xs font-bold px-2 py-0.5 rounded-md inline-flex items-center" style={{ background: "#f0f0ec" }}><TickerLabel symbol={t} showDollar={true} /></span>
                                ))}
                                {(card.tickers || []).length > 6 && (
                                  <span className="text-[11px] opacity-50">+{card.tickers.length - 6} more</span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {unread > 0 && (
                                <div className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-bold mr-1" style={{ background: "#7c3aed", color: "white" }}>
                                  <Bell size={10} /> {unread} new
                                </div>
                              )}
                              <button onClick={e => { e.stopPropagation(); toggleHawkeyeEnabled(card); }} className="p-1.5 rounded-full opacity-50 hover:opacity-100 hover:bg-gray-100 transition" title={card.enabled ? "Pause" : "Resume"}>
                                <Power size={13} />
                              </button>
                              <button onClick={e => { e.stopPropagation(); requestDeleteHawkeyeCard(card.id, card.name); }} className="p-1.5 rounded-full opacity-40 hover:opacity-100 hover:bg-red-50 transition" style={{ color: "#dc2626" }}>
                                <Trash2 size={13} />
                              </button>
                              <button className="p-1.5 rounded-full opacity-40 hover:opacity-100 hover:bg-gray-100 transition">
                                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                            </div>
                          </div>

                          {/* Conditions summary */}
                          <div className="flex items-center gap-2 flex-wrap mb-1" onClick={e => e.stopPropagation()}>
                            {(card.conditions || []).map((c, i) => (
                              <span key={i} className="text-[11px] px-2 py-1 rounded-md font-medium flex items-center gap-1 group/cond" style={{ background: c.direction === "gain" ? "#dcfce7" : "#fee2e2", color: c.direction === "gain" ? "#166534" : "#991b1b" }}>
                                {c.direction === "gain" ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
                                <span>{c.thresholdPct}% in {c.triggerWindowDays}d from {c.reference === "lowest" ? "low" : c.reference === "highest" ? "high" : "start"}</span>
                                {(card.conditions || []).length > 1 && (
                                  <button onClick={() => removeConditionFromCard(card.id, i)} className="opacity-0 group-hover/cond:opacity-100 transition" title="Remove condition">
                                    <X size={9} />
                                  </button>
                                )}
                              </span>
                            ))}
                            {addingConditionToCard === card.id ? (
                              <div className="w-full mt-2 p-2 rounded-lg flex items-center gap-1 flex-wrap" style={{ background: "white", border: "1px solid #e5e5e5" }}>
                                <span className="text-[11px] opacity-60">when price</span>
                                <select value={draftCondition.direction} onChange={e => setDraftCondition(d => ({ ...d, direction: e.target.value }))} className="text-[11px] px-1.5 py-0.5 rounded font-semibold focus:outline-none" style={{ background: "#f7f7f3", border: "1px solid #e5e5e5" }}>
                                  <option value="gain">gains</option>
                                  <option value="loss">loses</option>
                                </select>
                                <input type="number" min="1" value={draftCondition.thresholdPct} onChange={e => setDraftCondition(d => ({ ...d, thresholdPct: parseFloat(e.target.value) || 0 }))} className="w-12 text-[11px] px-1.5 py-0.5 rounded font-semibold text-center focus:outline-none" style={{ background: "#f7f7f3", border: "1px solid #e5e5e5" }} />
                                <span className="text-[11px] opacity-60">% in</span>
                                <input type="number" min="1" value={draftCondition.triggerWindowDays} onChange={e => setDraftCondition(d => ({ ...d, triggerWindowDays: parseInt(e.target.value) || 1 }))} className="w-12 text-[11px] px-1.5 py-0.5 rounded font-semibold text-center focus:outline-none" style={{ background: "#f7f7f3", border: "1px solid #e5e5e5" }} />
                                <span className="text-[11px] opacity-60">d from</span>
                                <select value={draftCondition.reference} onChange={e => setDraftCondition(d => ({ ...d, reference: e.target.value }))} className="text-[11px] px-1.5 py-0.5 rounded font-semibold focus:outline-none" style={{ background: "#f7f7f3", border: "1px solid #e5e5e5" }}>
                                  <option value="lowest">low</option>
                                  <option value="highest">high</option>
                                  <option value="first">start</option>
                                </select>
                                <button onClick={() => submitAddCondition(card.id)} className="text-[11px] px-2 py-0.5 rounded-md text-white font-medium" style={{ background: "#1a1a1a" }}>Add</button>
                                <button onClick={cancelAddCondition} className="text-[11px] px-2 py-0.5 rounded-md font-medium" style={{ background: "#f0f0ec" }}>Cancel</button>
                              </div>
                            ) : (
                              <button onClick={() => beginAddCondition(card.id)} className="text-[11px] px-2 py-1 rounded-md font-medium flex items-center gap-1 transition" style={{ background: "#f0f0ec", color: "#525252" }}>
                                <Plus size={9} /> Add condition
                              </button>
                            )}
                          </div>
                          <div className="text-[11px] opacity-50 mt-2 flex items-center gap-2 flex-wrap">
                            <span>{hits.length} {hits.length === 1 ? "hit" : "hits"} total</span>
                            {card.last_checked && (
                              <>
                                <span>·</span>
                                <span>Last checked {timeSinceText(new Date(card.last_checked).getTime())}</span>
                              </>
                            )}
                            {(() => {
                              const pending = (card.tickers || []).filter(t => bootstrapStatus[t] && !bootstrapStatus[t].bootstrapped);
                              if (pending.length === 0) return null;
                              return (
                                <>
                                  <span>·</span>
                                  <span className="flex items-center gap-1" style={{ color: "#7c3aed" }}>
                                    <RefreshCw size={9} className="animate-spin" /> Preparing {pending.length} ticker{pending.length === 1 ? "" : "s"}
                                  </span>
                                </>
                              );
                            })()}
                          </div>
                        </div>

                        {/* v4: DATA STATUS PANEL — visible per-ticker chart + run-now button */}
                        {isOpen && (
                          <div className="border-t px-5 py-4" style={{ borderColor: "#f0f0ec", background: "#fafaf7" }} onClick={e => e.stopPropagation()}>
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-2">
                                <Activity size={11} style={{ color: "#7c3aed" }} />
                                <span className="text-[11px] font-semibold tracking-widest uppercase opacity-60">Data status</span>
                              </div>
                              <button onClick={() => runHawkeyeCheckForCard(card.id)}
                                disabled={runningHawkeyeCheck[card.id]}
                                className="text-[11px] font-medium px-2.5 py-1 rounded-md flex items-center gap-1 transition disabled:opacity-50 text-white"
                                style={{ background: "#1a1a1a" }}>
                                {runningHawkeyeCheck[card.id]
                                  ? <><RefreshCw size={10} className="animate-spin" /> Checking…</>
                                  : <><RefreshCw size={10} /> Run check now</>}
                              </button>
                            </div>

                            {/* Result toast */}
                            {hawkeyeCheckResult[card.id] && !runningHawkeyeCheck[card.id] && (
                              <div className="mb-3 text-[11px] px-3 py-2 rounded-lg" style={{
                                background: hawkeyeCheckResult[card.id].error ? "#fee2e2" : "#dcfce7",
                                color:      hawkeyeCheckResult[card.id].error ? "#991b1b" : "#166534",
                              }}>
                                {hawkeyeCheckResult[card.id].error
                                  ? `Error: ${hawkeyeCheckResult[card.id].error}`
                                  : `Updated ${hawkeyeCheckResult[card.id].updated ?? 0} tickers · ${hawkeyeCheckResult[card.id].fired ?? 0} new hit${hawkeyeCheckResult[card.id].fired === 1 ? "" : "s"}${hawkeyeCheckResult[card.id].skipped_quote_not_today > 0 ? ` · ${hawkeyeCheckResult[card.id].skipped_quote_not_today} skipped (market closed today)` : ""}`}
                              </div>
                            )}

                            <div className="space-y-2">
                              {(card.tickers || []).map(t => {
                                const hist     = tickerHistoryCache[t];
                                const chartKey = `${card.id}_${t}`;
                                const isExpand = !!expandedTickerChart[chartKey];
                                const lastTs   = hist?.last_close_ts ? Number(hist.last_close_ts) : null;
                                const candleN  = hist?.candles?.length || 0;
                                const lastDate = lastTs ? new Date(lastTs) : null;
                                const daysAgo  = lastDate ? Math.floor((Date.now() - lastDate.getTime()) / 86400000) : null;
                                const isStale  = daysAgo != null && daysAgo > 5;
                                const isFresh  = daysAgo != null && daysAgo <= 4;
                                const isReady  = hist?.bootstrapped;
                                const livePx   = quotes[t]?.c || 0;

                                return (
                                  <div key={t}>
                                    <button onClick={() => toggleTickerChartExpand(card.id, t)}
                                      className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-gray-50 transition"
                                      style={{ background: "white", border: "1px solid #ececec" }}>
                                      <div className="flex items-center gap-2 min-w-0 flex-wrap">
                                        <span className="text-xs font-bold px-2 py-0.5 rounded-md flex-shrink-0 inline-flex items-center" style={{ background: "#f0f0ec" }}><TickerLabel symbol={t} showDollar={true} /></span>
                                        {isReady ? (
                                          <>
                                            <span className="text-[11px]" style={{ color: isStale ? "#dc2626" : isFresh ? "#059669" : "#525252" }}>
                                              Last close: {lastDate.toISOString().slice(0, 10)} ({daysAgo === 0 ? "today" : daysAgo === 1 ? "1d ago" : `${daysAgo}d ago`})
                                            </span>
                                            <span className="text-[11px] opacity-30">·</span>
                                            <span className="text-[11px] opacity-50">{candleN} candle{candleN === 1 ? "" : "s"}</span>
                                            {isStale && (
                                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: "#fee2e2", color: "#991b1b" }}>STALE</span>
                                            )}
                                          </>
                                        ) : (
                                          <span className="text-[11px] opacity-50 italic flex items-center gap-1">
                                            <RefreshCw size={9} className="animate-spin" /> Awaiting bootstrap…
                                          </span>
                                        )}
                                      </div>
                                      <ChevronDown size={11} className="opacity-50 flex-shrink-0" style={{ transform: isExpand ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }} />
                                    </button>
                                    {isExpand && (
                                      <div className="mt-2 p-3 rounded-lg" style={{ background: "white", border: "1px solid #ececec" }}>
                                        <HawkeyeMiniChart ticker={t} candles={hist?.candles || []} livePrice={livePx} />
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* HITS LIST */}
                        {isOpen && (
                          <div className="border-t" style={{ borderColor: "#f0f0ec" }}>
                            {hits.length === 0 ? (
                              <div className="px-5 py-6 text-center text-xs opacity-40 italic">
                                Watching. No hits yet — alerts will appear here when a stock matches a condition.
                              </div>
                            ) : (
                              <>
                                {unread > 0 && (
                                  <div className="px-5 py-2.5 flex items-center justify-end" style={{ background: "#fafaf7", borderBottom: "1px solid #f0f0ec" }}>
                                    <button onClick={() => markAllHawkeyeHitsRead(card.id)} className="text-[11px] font-medium flex items-center gap-1 opacity-60 hover:opacity-100 transition">
                                      <CheckCheck size={11} /> Mark all read
                                    </button>
                                  </div>
                                )}
                                <div className="divide-y" style={{ borderColor: "#f0f0ec" }}>
                                  {hits.map(h => {
                                    const cond = h.condition || {};
                                    const isGain = cond.direction === "gain";
                                    return (
                                      <div key={h.id} className="px-5 py-4 group transition" style={{ background: h.isRead ? "white" : "#faf5ff" }}>
                                        <div className="flex items-start justify-between gap-3">
                                          <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                                              {!h.isRead && <div className="w-1.5 h-1.5 rounded-full" style={{ background: "#7c3aed" }} />}
                                              <span className="text-xs font-bold px-2 py-0.5 rounded-md inline-flex items-center" style={{ background: "#f0f0ec" }}><TickerLabel symbol={h.ticker} showDollar={true} /></span>
                                              <span className="text-[11px] font-bold flex items-center gap-1" style={{ color: isGain ? "#059669" : "#dc2626" }}>
                                                {isGain ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                                                {h.pctChange > 0 ? "+" : ""}{h.pctChange}%
                                              </span>
                                              <span className="text-[11px] opacity-50">from {cond.reference === "lowest" ? "low" : cond.reference === "highest" ? "high" : "start"} of last {cond.triggerWindowDays}d</span>
                                              <span className="text-[11px] opacity-30">·</span>
                                              <span className="text-[11px] opacity-50">{timeSinceText(new Date(h.firedAt).getTime())}</span>
                                            </div>
                                            <div className="text-sm leading-relaxed">
                                              <span className="opacity-60">Fired at </span>
                                              <span className="font-semibold">{formatPrice(h.ticker, Number(h.firedPrice))}</span>
                                              <span className="opacity-60"> · reference {cond.reference} on {h.refDate} was </span>
                                              <span className="font-semibold">{formatPrice(h.ticker, Number(h.refPrice))}</span>
                                              <span className="opacity-60"> · condition: {cond.thresholdPct}% {cond.direction}</span>
                                            </div>
                                          </div>
                                          <div className="flex flex-col gap-1 opacity-40 group-hover:opacity-100 transition">
                                            {!h.isRead && (
                                              <button onClick={() => markHawkeyeHitRead(card.id, h.id)} title="Mark read" className="p-1 rounded hover:bg-gray-100" style={{ color: "#7c3aed" }}>
                                                <Check size={12} />
                                              </button>
                                            )}
                                            <button onClick={() => deleteHawkeyeHit(card.id, h.id)} title="Delete (re-arms the condition)" className="p-1 rounded hover:bg-gray-100">
                                              <X size={12} />
                                            </button>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {view === "compare" && (
            <section>
              <div className="mb-5 flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h2 className="font-serif-h text-3xl font-semibold mb-1">Compare</h2>
                  <p className="text-sm opacity-60 max-w-2xl">Build saved groups of up to 5 stocks and compare them on financials you paste in. Data is kept in your library to reuse. No AI — everything is computed instantly.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowStockLibrary(true)}
                    className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg font-medium"
                    style={{ background: "white", border: "1px solid #ececec" }}>
                    <Library size={14} /> Library {compareStocks.length > 0 ? `(${compareStocks.length})` : ""}
                  </button>
                  <button onClick={() => setShowAddCompareStock(true)}
                    className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg text-white font-medium"
                    style={{ background: "#1a1a1a" }}>
                    <Plus size={14} /> Add stock
                  </button>
                </div>
              </div>

              {/* Group tabs */}
              <div className="flex items-center gap-2 mb-6 flex-wrap">
                {compareGroups.map(g => {
                  const active = g.id === activeGroupId;
                  return (
                    <div key={g.id} className="flex items-center rounded-lg overflow-hidden" style={{ border: active ? "1px solid #0369a1" : "1px solid #ececec" }}>
                      <button onClick={() => setActiveGroupId(g.id)}
                        className="text-sm px-3 py-1.5 flex items-center gap-1.5"
                        style={{ background: active ? "#0369a1" : "white", color: active ? "white" : "#1a1a1a" }}>
                        <FolderOpen size={13} /> {g.name}
                        <span className="text-[10px] opacity-70">{(g.stockIds || []).length}</span>
                      </button>
                      {active && (
                        <button onClick={() => setCompareDeleteGroupId(g.id)} title="Delete group"
                          className="px-1.5 py-1.5" style={{ background: "#0369a1", color: "white" }}>
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
                {showNewGroup ? (
                  <div className="flex items-center gap-1 rounded-lg px-2 py-1" style={{ border: "1px solid #0369a1" }}>
                    <input autoFocus value={newCompareGroupName} onChange={e => setNewCompareGroupName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && newCompareGroupName.trim()) createCompareGroup(newCompareGroupName.trim()); if (e.key === "Escape") { setShowNewGroup(false); setNewCompareGroupName(""); } }}
                      placeholder="Group name" className="text-sm px-1 focus:outline-none w-32" />
                    <button onClick={() => newCompareGroupName.trim() && createCompareGroup(newCompareGroupName.trim())} className="p-1" style={{ color: "#0369a1" }}><Check size={14} /></button>
                  </div>
                ) : (
                  <button onClick={() => setShowNewGroup(true)} className="text-sm px-3 py-1.5 rounded-lg flex items-center gap-1.5 opacity-70 hover:opacity-100" style={{ border: "1px dashed #d4d4d4" }}>
                    <FolderPlus size={13} /> New group
                  </button>
                )}
              </div>

              {compareGroups.length === 0 ? (
                <div className="rounded-2xl p-12 text-center" style={{ background: "white", border: "1px dashed #d4d4d4" }}>
                  <GitCompare size={32} className="mx-auto mb-3 opacity-30" />
                  <p className="text-sm opacity-60 mb-1">No comparison groups yet.</p>
                  <p className="text-xs opacity-40 mb-4">Create a group, then add stocks to start comparing.</p>
                  <button onClick={() => setShowAddCompareStock(true)} className="text-sm px-4 py-2 rounded-lg text-white font-medium" style={{ background: "#1a1a1a" }}>
                    <Plus size={14} className="inline mr-1" /> Add your first stock
                  </button>
                </div>
              ) : !activeGroup ? null : (
                <>
                  {/* Stock chips for active group */}
                  <div className="flex flex-wrap gap-2 mb-5 items-center">
                    {activeStocks.map(s => (
                      <div key={s.id} className="flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-lg" style={{ background: "white", border: "1px solid #ececec" }}>
                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                        <span className="text-sm font-semibold">{s.ticker}</span>
                        {s.name && <span className="text-xs opacity-50">{s.name}</span>}
                        <select value={s.currency} onChange={e => changeCompareCurrency(s.id, e.target.value)}
                          className="text-[11px] rounded px-1 py-0.5 ml-1 focus:outline-none cursor-pointer" style={{ background: "#fafaf7", border: "1px solid #ececec" }}
                          title="Currency of this stock's data">
                          {Object.values(CURRENCIES).map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
                        </select>
                        <select value={s.scaleFactor || 1} onChange={e => changeCompareScale(s.id, Number(e.target.value))}
                          className="text-[11px] rounded px-1 py-0.5 focus:outline-none cursor-pointer" style={{ background: "#fafaf7", border: "1px solid #ececec" }}
                          title="Original magnitude of this stock's numbers">
                          {SCALE_OPTIONS.map(o => <option key={o.factor} value={o.factor}>{o.short}</option>)}
                        </select>
                        <span className="inline-flex items-center rounded overflow-hidden" style={{ border: "1px solid #ececec" }} title="Shift this stock's quarters on the charts to align fiscal calendars">
                          <button onClick={() => changeCompareOffset(s.id, (s.quarterOffset || 0) - 1)} className="px-1 text-[11px] hover:bg-gray-100" style={{ color: "#525252" }}>−</button>
                          <span className="text-[10px] px-1 tabular-nums" style={{ minWidth: 26, textAlign: "center" }}>
                            {(s.quarterOffset || 0) === 0 ? "Q±0" : `Q${s.quarterOffset > 0 ? "+" : ""}${s.quarterOffset}`}
                          </span>
                          <button onClick={() => changeCompareOffset(s.id, (s.quarterOffset || 0) + 1)} className="px-1 text-[11px] hover:bg-gray-100" style={{ color: "#525252" }}>+</button>
                        </span>
                        {s.livePrice != null && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "#dcfce7", color: "#166534" }} title="Yesterday's close used for live valuation">
                            {fmtNumber(s.livePrice, { compact: false, decimals: 2 })}
                          </span>
                        )}
                        <button onClick={() => removeStockFromGroup(s.id)} title="Remove from this group (keeps data in library)" className="p-0.5 opacity-40 hover:opacity-100"><X size={13} /></button>
                      </div>
                    ))}
                    {activeStocks.length < 5 && (
                      <button onClick={() => setShowStockLibrary(true)} className="text-xs px-3 py-2 rounded-lg flex items-center gap-1 opacity-60 hover:opacity-100" style={{ border: "1px dashed #d4d4d4" }}>
                        <Plus size={12} /> Add from library
                      </button>
                    )}
                  </div>

                  {/* Topic tags */}
                  <div className="flex flex-wrap gap-2 mb-5">
                    {TOPICS.map(t => {
                      const Icon = TOPIC_ICONS[t.icon] || BarChart3;
                      const active = compareTopic === t.id;
                      return (
                        <button key={t.id} onClick={() => setCompareTopic(t.id)} title={t.desc}
                          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full transition-all"
                          style={{ background: active ? "#0369a1" : "white", color: active ? "white" : "#1a1a1a", border: active ? "1px solid #0369a1" : "1px solid #ececec" }}>
                          <Icon size={13} /> {t.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Controls: period selector + USD toggle + refresh prices */}
                  <div className="flex items-center gap-3 mb-6 flex-wrap">
                    <div className="flex items-center gap-1 rounded-lg p-1" style={{ background: "#f0f0ec" }}>
                      <span className="text-[11px] opacity-50 px-2">Periods</span>
                      {[1, 2, 3].map(n => (
                        <button key={n} onClick={() => setComparePeriods(n)}
                          className="text-xs w-7 h-7 rounded-md font-medium transition-all"
                          style={{ background: comparePeriods === n ? "white" : "transparent", boxShadow: comparePeriods === n ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}>
                          {n}
                        </button>
                      ))}
                    </div>

                    <button onClick={() => setCompareUsd(v => !v)}
                      className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg font-medium transition-all"
                      style={{ background: compareUsd ? "#15803d" : "white", color: compareUsd ? "white" : "#1a1a1a", border: compareUsd ? "1px solid #15803d" : "1px solid #ececec" }}>
                      <Coins size={14} /> {compareUsd ? "USD" : "Original currency"}
                    </button>

                    <button onClick={() => refreshComparePrices()} disabled={loadingPrices}
                      className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg opacity-70 hover:opacity-100 disabled:opacity-40"
                      style={{ background: "white", border: "1px solid #ececec" }}>
                      <RefreshCw size={13} className={loadingPrices ? "animate-spin" : ""} /> {loadingPrices ? "Fetching…" : "Refresh prices & FX"}
                    </button>
                  </div>

                  {activeStocks.length < 2 && (
                    <div className="text-xs px-4 py-2.5 rounded-lg mb-5 inline-flex items-center gap-2" style={{ background: "#fef3c7", color: "#92400e" }}>
                      <AlertCircle size={12} /> Add at least one more stock to this group to see a real comparison.
                    </div>
                  )}
                  {fxMissing && (
                    <div className="text-xs px-4 py-2.5 rounded-lg mb-5 inline-flex items-center gap-2" style={{ background: "#fef3c7", color: "#92400e" }}>
                      <AlertCircle size={12} /> Some FX rates couldn't be fetched — those values stay in original currency. Try "Refresh prices & FX".
                    </div>
                  )}

                  {/* Tables */}
                  <div className="space-y-5 mb-6">
                    {compareBuilt.tables.map((tbl, i) => (
                      <CompareTable key={i} table={tbl} stocks={activeStocks} usd={compareUsd} />
                    ))}
                  </div>

                  {/* Charts */}
                  {compareBuilt.charts.some(c => c.type === "sankey-row") ? (
                    <div className="space-y-5">
                      {compareBuilt.charts.filter(c => c.type === "sankey-row").map((chart, ci) => (
                        <div key={ci}>
                          <div className="flex items-baseline justify-between mb-3 gap-2">
                            <h4 className="font-semibold text-sm">{chart.title}{compareUsd ? " · USD" : ""}</h4>
                            <span className="text-[10px] opacity-50">Width of each ribbon is proportional to the money flowing through it</span>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                            {chart.flows.map((flow, fi) => (
                              <MoneyFlowSankey key={fi} flow={flow} usd={compareUsd} />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                      {compareBuilt.charts.map((chart, i) => (
                        <CompareChart key={i} chart={chart} stocks={activeStocks} usd={compareUsd} />
                      ))}
                    </div>
                  )}
                </>
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
