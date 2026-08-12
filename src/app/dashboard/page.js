'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import AppShell from '@/components/AppShell';
import { useCurrency } from '@/context/CurrencyContext';
import { useAccount } from '@/context/AccountContext';
import { useAuth } from '@/context/AuthContext';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell
} from 'recharts';
import {
  ArrowUpRight, ArrowDownRight, ChevronUp, ChevronDown, ChevronRight,
  TrendingUp, TrendingDown, Minus, Search, Pause, Play, X, Loader2, Users, Zap,
  Power, PowerOff
} from 'lucide-react';
import { format, addDays, isSameDay } from 'date-fns';
import { useRouter } from 'next/navigation';

const CHART_METRICS = [
  { key: 'spend', label: 'Spend', color: 'hsl(217 91% 53%)', prefix: '$' },
  { key: 'clicks', label: 'Clicks', color: 'hsl(280 65% 60%)', prefix: '' },
  { key: 'impressions', label: 'Impressions', color: 'hsl(45 93% 55%)', prefix: '' },
  { key: 'conversions', label: 'Conversions', color: 'hsl(160 84% 39%)', prefix: '' },
  { key: 'cpc', label: 'CPC', color: 'hsl(350 80% 55%)', prefix: '$' },
  { key: 'ctr', label: 'CTR %', color: 'hsl(190 80% 45%)', prefix: '', suffix: '%' },
  { key: 'roas', label: 'ROAS', color: 'hsl(130 60% 45%)', prefix: '', suffix: 'x' },
];

const PIE_COLORS = ['hsl(217 91% 53%)', 'hsl(160 84% 39%)', 'hsl(280 65% 60%)', 'hsl(45 93% 55%)', 'hsl(350 80% 55%)', 'hsl(190 80% 45%)'];

export default function DashboardPage() {
  const { formatMoney, currency } = useCurrency();
  const { selectedAccountId, accountQueryParam } = useAccount();
  const { canPauseEnable, canCreateRules } = useAuth();
  const router = useRouter();
  const [dateRange, setDateRange] = useState({ from: addDays(new Date(), -14), to: new Date() });
  const [activePresetLabel, setActivePresetLabel] = useState(null);
  const isDateRestoredRef = useRef(false);

  // Restore date range from localStorage AFTER hydration (client-only)
  useEffect(() => {
    if (isDateRestoredRef.current) return;
    isDateRestoredRef.current = true;
    try {
      const saved = localStorage.getItem('dashboard_dateRange');
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (parsed.presetLabel) {
        const presetMap = {
          'Today': () => ({ from: new Date(), to: new Date() }),
          'Yesterday': () => ({ from: addDays(new Date(), -1), to: addDays(new Date(), -1) }),
          '7D': () => ({ from: addDays(new Date(), -7), to: new Date() }),
          '14D': () => ({ from: addDays(new Date(), -14), to: new Date() }),
          '30D': () => ({ from: addDays(new Date(), -30), to: new Date() }),
        };
        if (presetMap[parsed.presetLabel]) {
          setDateRange(presetMap[parsed.presetLabel]());
          setActivePresetLabel(parsed.presetLabel);
          return;
        }
      }
      if (parsed.from && parsed.to) {
        setDateRange({ from: new Date(parsed.from), to: new Date(parsed.to) });
      }
    } catch {}
  }, []);

  // Persist date range to localStorage (skip initial mount)
  const hasMountedRef = useRef(false);
  useEffect(() => {
    if (!hasMountedRef.current) { hasMountedRef.current = true; return; }
    try {
      localStorage.setItem('dashboard_dateRange', JSON.stringify({
        from: dateRange.from.toISOString(),
        to: dateRange.to.toISOString(),
        presetLabel: activePresetLabel,
      }));
    } catch {}
  }, [dateRange, activePresetLabel]);

  const [breakdown, setBreakdown] = useState('day');
  const [chartMetric, setChartMetric] = useState('spend');

  const [kpis, setKpis] = useState(null);
  const [chart, setChart] = useState([]);
  const [trends, setTrends] = useState(null);
  const [performance, setPerformance] = useState({ topCampaigns: [], bottomCampaigns: [] });

  const [campaigns, setCampaigns] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [summary, setSummary] = useState(null);

  const [sortKey, setSortKey] = useState('spend');
  const [sortDir, setSortDir] = useState('desc');
  const [searchQuery, setSearchQuery] = useState('');
  const [perfFilter, setPerfFilter] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  // Fetch toggle — default ON, persisted in localStorage
  const [fetchEnabled, setFetchEnabled] = useState(false); // false for SSR, restored below

  // Restore all filter state from localStorage on mount
  const filtersRestoredRef = useRef(false);
  useEffect(() => {
    if (filtersRestoredRef.current) return;
    filtersRestoredRef.current = true;
    try {
      // fetchEnabled: default true on first visit
      const fe = localStorage.getItem('dashboard_fetchEnabled');
      setFetchEnabled(fe === null ? true : fe === 'true');
      // Other filters
      const b = localStorage.getItem('dashboard_breakdown');
      if (b) setBreakdown(b);
      const cm = localStorage.getItem('dashboard_chartMetric');
      if (cm) setChartMetric(cm);
      const sk = localStorage.getItem('dashboard_sortKey');
      if (sk) setSortKey(sk);
      const sd = localStorage.getItem('dashboard_sortDir');
      if (sd) setSortDir(sd);
      const pf = localStorage.getItem('dashboard_perfFilter');
      if (pf !== null) setPerfFilter(pf);
    } catch {}
  }, []);

  // Persist fetchEnabled whenever it changes
  const fetchEnabledMountedRef = useRef(false);
  useEffect(() => {
    if (!fetchEnabledMountedRef.current) { fetchEnabledMountedRef.current = true; return; }
    try { localStorage.setItem('dashboard_fetchEnabled', String(fetchEnabled)); } catch {}
  }, [fetchEnabled]);

  // Persist filters whenever they change
  const filtersMountedRef = useRef(false);
  useEffect(() => {
    if (!filtersMountedRef.current) { filtersMountedRef.current = true; return; }
    try {
      localStorage.setItem('dashboard_breakdown', breakdown);
      localStorage.setItem('dashboard_chartMetric', chartMetric);
      localStorage.setItem('dashboard_sortKey', sortKey);
      localStorage.setItem('dashboard_sortDir', sortDir);
      localStorage.setItem('dashboard_perfFilter', perfFilter);
    } catch {}
  }, [breakdown, chartMetric, sortKey, sortDir, perfFilter]);

  // Drill-down state
  const [expandedCampaign, setExpandedCampaign] = useState(null);
  const [drillData, setDrillData] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);

  // Audience state
  const [audience, setAudience] = useState(null);
  const [audienceLoading, setAudienceLoading] = useState(false);
  const [showAudience, setShowAudience] = useState(false);

  // Action state
  const [actionLoading, setActionLoading] = useState({});

  // Cache & debounce
  const cacheRef = useRef({});
  const searchTimerRef = useRef(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(searchTimerRef.current);
  }, [searchQuery]);

  const dateFrom = format(dateRange.from, 'yyyy-MM-dd');
  const dateTo = format(dateRange.to, 'yyyy-MM-dd');

  // Fetch overview data — always fetch fresh, use cache only as instant placeholder
  const fetchOverview = useCallback(async () => {
    const cacheKey = `ov_${dateFrom}_${dateTo}_${breakdown}_${selectedAccountId}`;
    const cached = cacheRef.current[cacheKey];
    if (cached) {
      setKpis(cached.kpis); setChart(cached.chart); setTrends(cached.trends); setPerformance(cached.performance);
    }
    try {
      const res = await fetch(`/api/analytics/overview?from=${dateFrom}&to=${dateTo}&breakdown=${breakdown}${accountQueryParam}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.kpis) setKpis(data.kpis);
      if (data.chart) setChart(data.chart);
      if (data.trends) setTrends(data.trends);
      if (data.performance) setPerformance(data.performance);
      cacheRef.current = { [cacheKey]: data };
    } catch {}
  }, [dateFrom, dateTo, breakdown, accountQueryParam, selectedAccountId]);

  // Fetch campaign table
  const fetchCampaigns = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        from: dateFrom, to: dateTo,
        sort: sortKey, order: sortDir,
        page: String(page), limit: '25',
      });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (perfFilter) params.set('performance', perfFilter);
      if (selectedAccountId !== 'all') params.set('account', selectedAccountId);
      const res = await fetch(`/api/analytics/campaigns?${params}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.campaigns) setCampaigns(data.campaigns);
      if (data.pagination) setPagination(data.pagination);
      if (data.summary) setSummary(data.summary);
    } catch {}
  }, [dateFrom, dateTo, sortKey, sortDir, page, debouncedSearch, perfFilter, selectedAccountId]);

  useEffect(() => {
    if (!fetchEnabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([fetchOverview(), fetchCampaigns()]).finally(() => setLoading(false));

    // Auto-refresh from DB every 60 seconds (free, no Meta API calls)
    const interval = setInterval(() => {
      fetchOverview();
      fetchCampaigns();
    }, 60_000);
    return () => clearInterval(interval);
  }, [fetchOverview, fetchCampaigns, fetchEnabled]);

  useEffect(() => { setPage(1); }, [debouncedSearch, perfFilter, selectedAccountId]);

  // Drill-down
  const toggleDrill = async (campaignId) => {
    if (expandedCampaign === campaignId) { setExpandedCampaign(null); setDrillData(null); return; }
    setExpandedCampaign(campaignId);
    setDrillLoading(true);
    try {
      const res = await fetch(`/api/analytics/campaign-detail?id=${campaignId}&from=${dateFrom}&to=${dateTo}`);
      if (res.ok) setDrillData(await res.json());
    } catch {}
    setDrillLoading(false);
  };

  // Audience
  const fetchAudience = async () => {
    if (audience) { setShowAudience(!showAudience); return; }
    setShowAudience(true);
    setAudienceLoading(true);
    try {
      const acctParam = selectedAccountId !== 'all' ? `&account=${selectedAccountId}` : '';
      const res = await fetch(`/api/analytics/audience?from=${dateFrom}&to=${dateTo}${acctParam}`);
      if (res.ok) setAudience(await res.json());
    } catch {}
    setAudienceLoading(false);
  };

  // Quick actions
  const handleAction = async (campaignId, action) => {
    setActionLoading(l => ({ ...l, [campaignId]: action }));
    try {
      const res = await fetch('/api/campaigns/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId, action }),
      });
      if (res.ok) await fetchCampaigns();
    } catch {}
    setActionLoading(l => ({ ...l, [campaignId]: null }));
  };

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const SortIcon = ({ col }) => {
    if (sortKey !== col) return null;
    return sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />;
  };

  const kpiCards = kpis ? [
    { label: 'SPEND', value: formatMoney(kpis.spend.value), change: kpis.spend.change, accent: 'bg-primary' },
    { label: 'REACH', value: formatNum(kpis.reach?.value), change: kpis.reach?.change, accent: 'bg-success' },
    { label: 'CLICKS', value: formatNum(kpis.clicks?.value), change: kpis.clicks?.change, accent: 'bg-warning' },
    { label: 'CPC', value: formatMoney(kpis.cpc?.value), change: kpis.cpc?.change, accent: 'bg-info', invertColor: true },
    { label: 'CTR', value: `${(kpis.ctr?.value || 0).toFixed(2)}%`, change: kpis.ctr?.change, accent: 'bg-purple-500' },
    { label: 'ROAS', value: `${(kpis.roas?.value || 0).toFixed(1)}x`, change: kpis.roas?.change, accent: 'bg-success' },
  ] : [];

  const presets = [
    { label: 'Today', get: () => ({ from: new Date(), to: new Date() }) },
    { label: 'Yesterday', get: () => ({ from: addDays(new Date(), -1), to: addDays(new Date(), -1) }) },
    { label: '7D', get: () => ({ from: addDays(new Date(), -7), to: new Date() }) },
    { label: '14D', get: () => ({ from: addDays(new Date(), -14), to: new Date() }) },
    { label: '30D', get: () => ({ from: addDays(new Date(), -30), to: new Date() }) },
  ];

  const activeChartMetric = CHART_METRICS.find(m => m.key === chartMetric) || CHART_METRICS[0];

  // Budget pacing helper
  const getPacing = (c) => {
    if (!c.dailyBudget || c.dailyBudget <= 0) return null;
    const daysDiff = Math.max(1, Math.ceil((new Date(dateTo) - new Date(dateFrom)) / 86400000));
    const expectedSpend = c.dailyBudget * daysDiff;
    const pct = expectedSpend > 0 ? (c.spend / expectedSpend) * 100 : 0;
    if (pct >= 90 && pct <= 110) return { label: 'On Pace', color: 'text-success bg-success/10' };
    if (pct < 90) return { label: `${pct.toFixed(0)}% Under`, color: 'text-warning bg-warning/10' };
    return { label: `${pct.toFixed(0)}% Over`, color: 'text-destructive bg-destructive/10' };
  };

  return (
    <AppShell title="Performance Overview">
      {/* ─── Fetch Toggle ─── */}
      <div className={`flex items-center justify-between mb-6 px-5 py-4 rounded-xl border transition-all duration-300 ${
        fetchEnabled
          ? 'bg-success/5 border-success/30'
          : 'bg-card border-border shadow-card'
      }`}>
        <div className="flex items-center gap-3">
          {fetchEnabled
            ? <Power size={20} className="text-success" />
            : <PowerOff size={20} className="text-muted-foreground" />
          }
          <div>
            <p className="text-sm font-semibold text-foreground">
              {fetchEnabled ? 'Data Fetching Active' : 'Data Fetching Paused'}
            </p>
            <p className="text-xs text-muted-foreground">
              {fetchEnabled
                ? 'Live data is being loaded — auto-refreshes every 60s'
                : 'Turn on to start loading analytics data — no API calls while off'
              }
            </p>
          </div>
        </div>
        <button
          onClick={() => setFetchEnabled(v => !v)}
          className={`relative w-14 h-7 rounded-full transition-colors duration-300 ${
            fetchEnabled ? 'bg-success' : 'bg-muted'
          }`}
        >
          <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform duration-300 ${
            fetchEnabled ? 'translate-x-7' : 'translate-x-0'
          }`} />
        </button>
      </div>

      {/* Show paused state when fetch is disabled */}
      {!fetchEnabled && (
        <div className="bg-card rounded-xl border border-border shadow-card p-16 text-center mb-8">
          <PowerOff size={40} className="mx-auto text-muted-foreground/40 mb-4" />
          <h3 className="text-lg font-semibold text-foreground mb-2">Fetching is Off</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Enable the toggle above to start loading analytics data. No API calls are made while this is off.
          </p>
        </div>
      )}
      {fetchEnabled && (<>
      {/* Controls — single unified row */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {/* Date presets */}
        <div className="flex items-center bg-muted rounded-lg p-0.5">
          {presets.map(p => {
            const r = p.get();
            const active = activePresetLabel === p.label || (!activePresetLabel && isSameDay(dateRange.from, r.from) && isSameDay(dateRange.to, r.to));
            return (
              <button key={p.label} onClick={() => { setDateRange(p.get()); setActivePresetLabel(p.label); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${active ? 'bg-surface text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground'}`}
              >{p.label}</button>
            );
          })}
        </div>

        {/* Custom date range */}
        <div className="flex items-center gap-1.5">
          <input type="date" value={dateFrom} onChange={e => { setDateRange(r => ({ ...r, from: new Date(e.target.value) })); setActivePresetLabel(null); }}
            className="px-2 py-1.5 text-xs border border-border rounded-md bg-surface text-foreground" />
          <span className="text-[10px] text-muted-foreground">to</span>
          <input type="date" value={dateTo} onChange={e => { setDateRange(r => ({ ...r, to: new Date(e.target.value) })); setActivePresetLabel(null); }}
            className="px-2 py-1.5 text-xs border border-border rounded-md bg-surface text-foreground" />
        </div>

        {/* Separator */}
        <div className="w-px h-6 bg-border mx-1" />

        {/* Breakdown */}
        <div className="flex items-center bg-muted rounded-lg p-0.5">
          {['Day', 'Week', 'Month'].map(b => (
            <button key={b} onClick={() => setBreakdown(b.toLowerCase())}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${breakdown === b.toLowerCase() ? 'bg-surface text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground'}`}
            >{b}</button>
          ))}
        </div>

        {/* Separator */}
        <div className="w-px h-6 bg-border mx-1" />

        {/* Audience toggle */}
        <button onClick={fetchAudience}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-all ${showAudience ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
        ><Users size={12} /> Audience</button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        {loading && !kpis ? (
          Array(6).fill(0).map((_, i) => (
            <div key={i} className="bg-card rounded-xl border border-border shadow-card overflow-hidden">
              <div className="h-0.5 bg-muted" />
              <div className="p-4 space-y-2">
                <div className="h-3 w-12 bg-muted rounded animate-pulse" />
                <div className="h-6 w-20 bg-muted rounded animate-pulse" />
              </div>
            </div>
          ))
        ) : kpiCards.map((kpi) => {
          const isGood = kpi.invertColor ? (kpi.change || 0) < 0 : (kpi.change || 0) > 0;
          return (
            <div key={kpi.label} className="bg-card rounded-xl border border-border shadow-card card-hover overflow-hidden">
              <div className={`h-0.5 ${kpi.accent}`} />
              <div className="p-4">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{kpi.label}</span>
                <div className="mt-1 text-xl font-bold text-foreground">{kpi.value}</div>
                {kpi.change != null && (
                  <div className={`flex items-center gap-1 mt-1 text-xs font-medium ${isGood ? 'text-success' : 'text-destructive'}`}>
                    {isGood ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                    {Math.abs(kpi.change).toFixed(1)}%
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Chart with Metric Toggle */}
      <div className="bg-card rounded-xl border border-border shadow-card p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">Performance Chart</h3>
          <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
            {CHART_METRICS.map(m => (
              <button key={m.key} onClick={() => setChartMetric(m.key)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded transition-all ${chartMetric === m.key ? 'bg-surface text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground'}`}
              >{m.label}</button>
            ))}
          </div>
        </div>
        {chart.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chart}>
              <defs>
                <linearGradient id="chartG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={activeChartMetric.color} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={activeChartMetric.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(210 40% 96%)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(215 16% 62%)" tickFormatter={d => {
                if (d.length === 7) return d;
                const dt = new Date(d);
                return `${dt.getMonth()+1}/${dt.getDate()}`;
              }} />
              <YAxis tick={{ fontSize: 11 }} stroke="hsl(215 16% 62%)" tickFormatter={v =>
                activeChartMetric.prefix === '$' ? `${currency === 'INR' ? '₹' : '$'}${v.toFixed?.(0) || v}` :
                activeChartMetric.suffix ? `${v}${activeChartMetric.suffix}` : formatNum(v)
              } />
              <Tooltip contentStyle={{ backgroundColor: 'white', border: '1px solid hsl(220 13% 91%)', borderRadius: 8, fontSize: 12 }}
                formatter={(v) => [`${activeChartMetric.prefix}${typeof v === 'number' ? v.toFixed(2) : v}${activeChartMetric.suffix || ''}`, activeChartMetric.label]} />
              <Area type="monotone" dataKey={chartMetric} stroke={activeChartMetric.color} fill="url(#chartG)" strokeWidth={2} name={activeChartMetric.label} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="text-center py-12 text-sm text-muted-foreground">
            {loading ? 'Loading chart data...' : 'No data yet — connect and sync'}
          </div>
        )}
      </div>

      {/* Audience Breakdown */}
      {showAudience && (
        <div className="bg-card rounded-xl border border-border shadow-card p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><Users size={14} /> Audience Breakdown</h3>
            <button onClick={() => setShowAudience(false)} className="p-1 rounded hover:bg-muted"><X size={16} /></button>
          </div>
          {audienceLoading ? (
            <div className="text-center py-8"><Loader2 size={20} className="animate-spin mx-auto text-primary" /><p className="text-xs text-muted-foreground mt-2">Loading from Meta API...</p></div>
          ) : audience ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Age */}
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-3">By Age</h4>
                {audience.ageGender?.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={audience.ageGender.slice(0, 8)}>
                      <XAxis dataKey="age" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${v}`} />
                      <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} />
                      <Bar dataKey="spend" fill="hsl(217 91% 53%)" radius={[4,4,0,0]} name="Spend" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <p className="text-xs text-muted-foreground">No data</p>}
              </div>
              {/* Country */}
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-3">Top Countries</h4>
                {audience.country?.length > 0 ? (
                  <div className="space-y-2">
                    {audience.country.slice(0, 6).map(c => {
                      const maxSpend = audience.country[0]?.spend || 1;
                      return (
                        <div key={c.country} className="flex items-center gap-2">
                          <span className="text-sm font-medium w-8">{c.country}</span>
                          <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                            <div className="h-full bg-primary rounded-full" style={{ width: `${(c.spend / maxSpend) * 100}%` }} />
                          </div>
                          <span className="text-xs text-muted-foreground w-16 text-right">{formatMoney(c.spend)}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : <p className="text-xs text-muted-foreground">No data</p>}
              </div>
              {/* Device */}
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-3">By Device</h4>
                {audience.device?.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={audience.device} dataKey="spend" nameKey="device" cx="50%" cy="50%" outerRadius={70} innerRadius={35}>
                        {audience.device.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} formatter={v => formatMoney(v)} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : <p className="text-xs text-muted-foreground">No data</p>}
              </div>
            </div>
          ) : <p className="text-xs text-muted-foreground">Failed to load audience data</p>}
        </div>
      )}

      {/* Top/Bottom Performers */}
      {(performance.topCampaigns.length > 0 || performance.bottomCampaigns.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          <div className="bg-card rounded-xl border border-border shadow-card p-5">
            <h4 className="text-sm font-semibold text-foreground mb-3">🏆 Top Performers</h4>
            {performance.topCampaigns.map((c, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-border-soft last:border-0">
                <span className="text-sm text-foreground truncate mr-2">{c.name}</span>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-success font-semibold">{(c.roas || 0).toFixed(1)}x</span>
                  <span className="text-xs text-muted-foreground">{formatMoney(c.spend)}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="bg-card rounded-xl border border-border shadow-card p-5">
            <h4 className="text-sm font-semibold text-foreground mb-3">⚠️ Underperformers</h4>
            {performance.bottomCampaigns.map((c, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-border-soft last:border-0">
                <span className="text-sm text-foreground truncate mr-2">{c.name}</span>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-destructive font-semibold">{(c.roas || 0).toFixed(1)}x</span>
                  <span className="text-xs text-muted-foreground">{formatMoney(c.spend)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary Stats */}
      {summary && (
        <div className="flex flex-wrap gap-3 mb-4">
          {[
            { label: 'Total', val: summary.totalCampaigns },
            { label: 'Active', val: summary.activeCampaigns, color: 'text-success' },
            { label: 'Profitable', val: summary.profitableCampaigns, color: 'text-success' },
            { label: 'Losing', val: summary.losingCampaigns, color: 'text-destructive' },
            { label: 'Avg ROAS', val: `${summary.avgRoas}x` },
            { label: 'Total Spend', val: formatMoney(summary.totalSpend) },
          ].map(s => (
            <div key={s.label} className="bg-card border border-border rounded-lg px-3 py-2 text-center">
              <div className="text-[10px] uppercase text-muted-foreground">{s.label}</div>
              <div className={`text-sm font-bold ${s.color || 'text-foreground'}`}>{s.val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Campaign Table with Quick Actions + Drill-Down */}
      <div className="bg-card rounded-xl border border-border shadow-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-border">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search campaigns..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
          <div className="flex items-center bg-muted rounded-md p-0.5">
            {[{ l: 'All', v: '' }, { l: 'Top', v: 'top' }, { l: 'Avg', v: 'average' }, { l: 'Losing', v: 'losing' }].map(f => (
              <button key={f.l} onClick={() => setPerfFilter(f.v)}
                className={`px-3 py-1 text-xs font-medium rounded transition-all ${perfFilter === f.v ? 'bg-surface text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground'}`}
              >{f.l}</button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-elevated">
                <th className="w-8" />
                {[
                  ['name', 'Name'], ['status', 'Status'], ['spend', 'Spend'],
                  ['reach', 'Reach'], ['clicks', 'Clicks'], ['conversions', 'Conv.'], ['cpc', 'CPC'],
                  ['ctr', 'CTR'], ['roas', 'ROAS'], ['performanceTier', 'Tier'],
                ].map(([key, label]) => (
                  <th key={key} onClick={() => handleSort(key)}
                    className={`text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider cursor-pointer hover:text-foreground transition-colors select-none ${sortKey === key ? 'text-primary' : 'text-muted-foreground'}`}
                  ><span className="flex items-center gap-1">{label}<SortIcon col={key} /></span></th>
                ))}
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pacing</th>
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.length === 0 && !loading ? (
                <tr><td colSpan={13} className="text-center py-12 text-sm text-muted-foreground">No campaigns found</td></tr>
              ) : campaigns.map((c) => {
                const pacing = getPacing(c);
                const isExpanded = expandedCampaign === c.id;
                return (
                  <> 
                    <tr key={c.id} className={`border-b border-border-soft hover:bg-muted/30 transition-colors ${isExpanded ? 'bg-muted/20' : ''}`}>
                      <td className="px-2">
                        <button onClick={() => toggleDrill(c.id)} className="p-1 rounded hover:bg-muted transition-transform">
                          <ChevronRight size={14} className={`text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                        </button>
                      </td>
                      <td className="px-4 py-3 font-medium text-foreground max-w-[200px] truncate">{c.name}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${c.status === 'ACTIVE' ? 'bg-success/10 text-success' : c.status === 'PAUSED' ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${c.status === 'ACTIVE' ? 'bg-success' : c.status === 'PAUSED' ? 'bg-warning' : 'bg-muted-foreground'}`} />
                          {c.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">{formatMoney(c.spend)}</td>
                      <td className="px-4 py-3" title={c.reachEstimated ? 'Approximate (summed daily)' : 'Deduplicated reach'}>
                        {c.reachEstimated ? '~' : ''}{formatNum(c.reach)}
                      </td>
                      <td className="px-4 py-3">{formatNum(c.clicks)}</td>
                      <td className="px-4 py-3">{c.conversions}</td>
                      <td className="px-4 py-3">{formatMoney(c.cpc)}</td>
                      <td className="px-4 py-3">{(c.ctr || 0).toFixed(2)}%</td>
                      <td className={`px-4 py-3 font-semibold ${c.roas >= 3 ? 'text-success' : c.roas >= 1 ? 'text-warning' : 'text-destructive'}`}>{(c.roas || 0).toFixed(2)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                          c.performanceTier === 'top' ? 'bg-success/10 text-success' :
                          c.performanceTier === 'average' ? 'bg-primary/10 text-primary' :
                          c.performanceTier === 'losing' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
                        }`}>{c.performanceTier || '—'}</span>
                      </td>
                      <td className="px-4 py-3">
                        {pacing ? (
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${pacing.color}`}>{pacing.label}</span>
                        ) : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        {canPauseEnable && (
                        <div className="flex items-center gap-1">
                          {c.status === 'ACTIVE' ? (
                            <button onClick={() => handleAction(c.id, 'pause')} disabled={!!actionLoading[c.id]}
                              className="p-1.5 rounded-md bg-warning/10 text-warning hover:bg-warning/20 transition-colors disabled:opacity-50" title="Pause">
                              {actionLoading[c.id] === 'pause' ? <Loader2 size={12} className="animate-spin" /> : <Pause size={12} />}
                            </button>
                          ) : (
                            <button onClick={() => handleAction(c.id, 'enable')} disabled={!!actionLoading[c.id]}
                              className="p-1.5 rounded-md bg-success/10 text-success hover:bg-success/20 transition-colors disabled:opacity-50" title="Enable">
                              {actionLoading[c.id] === 'enable' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                            </button>
                          )}
                          {canCreateRules && (
                          <button onClick={() => router.push(`/automation?campaign=${c.id}&name=${encodeURIComponent(c.name)}`)}
                            className="p-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors" title="Add Rule">
                            <Zap size={12} />
                          </button>
                          )}
                        </div>
                        )}
                      </td>
                    </tr>
                    {/* Drill-down row */}
                    {isExpanded && (
                      <tr key={`${c.id}-drill`}>
                        <td colSpan={13} className="bg-muted/10 px-8 py-4 border-b border-border">
                          {drillLoading ? (
                            <div className="flex items-center gap-2 py-4"><Loader2 size={16} className="animate-spin text-primary" /><span className="text-xs text-muted-foreground">Loading ad sets...</span></div>
                          ) : drillData?.adSets?.length > 0 ? (
                            <div>
                              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-3">Ad Sets ({drillData.adSets.length})</h4>
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b border-border">
                                    {['Name', 'Status', 'Spend', 'Reach', 'Clicks', 'Impressions', 'CPC', 'CTR', 'ROAS', 'Targeting'].map(h => (
                                      <th key={h} className="text-left px-3 py-2 font-semibold text-muted-foreground uppercase">{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {drillData.adSets.map(as => (
                                    <tr key={as.externalId} className="border-b border-border-soft hover:bg-muted/20">
                                      <td className="px-3 py-2 font-medium text-foreground max-w-[180px] truncate">{as.name}</td>
                                      <td className="px-3 py-2">
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${as.status === 'ACTIVE' ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}`}>{as.status}</span>
                                      </td>
                                      <td className="px-3 py-2">{formatMoney(as.spend)}</td>
                                      <td className="px-3 py-2" title="Approximate (summed daily)">~{formatNum(as.reach)}</td>
                                      <td className="px-3 py-2">{formatNum(as.clicks)}</td>
                                      <td className="px-3 py-2">{formatNum(as.impressions)}</td>
                                      <td className="px-3 py-2">{formatMoney(as.cpc)}</td>
                                      <td className="px-3 py-2">{(as.ctr || 0).toFixed(2)}%</td>
                                      <td className={`px-3 py-2 font-semibold ${as.roas >= 1 ? 'text-success' : 'text-destructive'}`}>{(as.roas || 0).toFixed(2)}</td>
                                      <td className="px-3 py-2 text-muted-foreground max-w-[200px] truncate">{as.targetingSummary || '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground py-2">No ad sets found for this campaign</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border">
            <span className="text-xs text-muted-foreground">
              Showing {(pagination.page - 1) * pagination.limit + 1}-{Math.min(pagination.page * pagination.limit, pagination.totalCount)} of {pagination.totalCount}
            </span>
            <div className="flex items-center gap-2">
              <button disabled={!pagination.hasPrev} onClick={() => setPage(p => p - 1)}
                className="px-3 py-1 text-xs font-medium border border-border rounded hover:bg-muted disabled:opacity-40 transition-colors"
              >← Prev</button>
              <span className="text-xs text-muted-foreground">Page {pagination.page}/{pagination.totalPages}</span>
              <button disabled={!pagination.hasNext} onClick={() => setPage(p => p + 1)}
                className="px-3 py-1 text-xs font-medium border border-border rounded hover:bg-muted disabled:opacity-40 transition-colors"
              >Next →</button>
            </div>
          </div>
        )}
      </div>
      </>)}
    </AppShell>
  );
}

function ChangeInline({ value }) {
  if (!value) return null;
  const isPos = value > 0;
  return (
    <span className={`ml-1 text-[10px] font-medium ${isPos ? 'text-success' : 'text-destructive'}`}>
      {isPos ? '+' : ''}{value.toFixed(1)}%
    </span>
  );
}

function formatNum(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
