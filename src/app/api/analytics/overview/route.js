import { NextResponse } from 'next/server';
import { queryRows, queryOne } from '@/lib/db';
import { fetchPeriodReach } from '@/lib/meta-api';

export const dynamic = 'force-dynamic';

// GET /api/analytics/overview — Advanced KPI + Chart data
// Optimized: 3 queries total instead of N+1
export async function GET(request) {
  const { searchParams } = new URL(request.url);

  let dateFrom, dateTo;
  if (searchParams.get('from') && searchParams.get('to')) {
    dateFrom = searchParams.get('from');
    dateTo = searchParams.get('to');
  } else {
    const days = parseInt(searchParams.get('days') || '7');
    dateTo = new Date().toISOString().split('T')[0];
    dateFrom = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  }

  const accountId = searchParams.get('account');
  const compareMode = searchParams.get('compare') || 'previous';
  const breakdown = searchParams.get('breakdown') || 'day';

  try {
    // QUERY 1: All campaigns in ONE query
    const campaigns = accountId
      ? await queryRows(`SELECT id, name, status, objective, meta_account_id FROM campaigns WHERE meta_account_id = $1`, [accountId])
      : await queryRows(`SELECT id, name, status, objective, meta_account_id FROM campaigns`);

    const campaignIds = campaigns.map(c => c.id);
    const campaignLookup = {};
    for (const c of campaigns) campaignLookup[c.id] = c;

    if (!campaignIds.length) {
      return NextResponse.json({
        kpis: emptyKPIs(), chart: [], performance: { topCampaigns: [], bottomCampaigns: [] },
        objectiveBreakdown: [], trends: {}, period: { from: dateFrom, to: dateTo },
      });
    }

    // QUERIES 2 + 3 in parallel: current period + comparison
    const { compFrom, compTo } = getComparisonDates(dateFrom, dateTo, compareMode);

    const [currentMetrics, previousMetrics] = await Promise.all([
      queryRows(
        `SELECT spend, impressions, clicks, conversions, conversion_value, reach, frequency, date, campaign_id
         FROM metrics WHERE entity_type = 'campaign' AND campaign_id = ANY($1::uuid[]) AND date >= $2 AND date <= $3
         ORDER BY date ASC`,
        [campaignIds, dateFrom, dateTo]
      ),
      compFrom
        ? queryRows(
            `SELECT spend, impressions, clicks, conversions, conversion_value, reach, frequency
             FROM metrics WHERE entity_type = 'campaign' AND campaign_id = ANY($1::uuid[]) AND date >= $2 AND date <= $3`,
            [campaignIds, compFrom, compTo]
          )
        : Promise.resolve([]),
    ]);

    const current = aggregateMetrics(currentMetrics);
    const previous = aggregateMetrics(previousMetrics);

    // REACH: Fetch deduplicated reach from Meta API
    let deduplicatedReach = { current: 0, previous: 0 };
    try {
      // Filter out null values before uuid[] cast — null meta_account_id would crash Postgres
      const accountMetaIds = [...new Set(campaigns.map(c => c.meta_account_id).filter(Boolean))];
      const accounts = accountMetaIds.length
        ? await queryRows(
            `SELECT id, meta_account_id, access_token FROM meta_accounts WHERE id = ANY($1::uuid[]) AND is_active = true`,
            [accountMetaIds]
          )
        : [];
      if (accounts.length) {
        const reachResults = await Promise.all(accounts.map(async (acc) => {
          const [currReach, prevReach] = await Promise.all([
            fetchPeriodReach(acc.meta_account_id, acc.access_token, dateFrom, dateTo).catch(() => 0),
            compFrom ? fetchPeriodReach(acc.meta_account_id, acc.access_token, compFrom, compTo).catch(() => 0) : 0,
          ]);
          return { current: currReach, previous: prevReach };
        }));
        for (const r of reachResults) {
          deduplicatedReach.current += r.current;
          deduplicatedReach.previous += r.previous;
        }
      }
    } catch (reachErr) {
      console.warn('[Overview] Deduplicated reach failed, using summed daily:', reachErr.message);
      deduplicatedReach.current = current.reach;
      deduplicatedReach.previous = previous.reach;
    }

    current.reach = deduplicatedReach.current;
    previous.reach = deduplicatedReach.previous;
    const chartData = buildChartData(currentMetrics, breakdown);

    // Campaign performance (from already-fetched data — no extra queries)
    const perfMap = {};
    for (const row of currentMetrics) {
      if (!perfMap[row.campaign_id]) perfMap[row.campaign_id] = { spend: 0, clicks: 0, conversions: 0, conversionValue: 0, impressions: 0 };
      const p = perfMap[row.campaign_id];
      p.spend += parseFloat(row.spend || 0); p.clicks += parseInt(row.clicks || 0);
      p.conversions += parseFloat(row.conversions || 0); p.conversionValue += parseFloat(row.conversion_value || 0);
      p.impressions += parseInt(row.impressions || 0);
    }

    const campaignPerformance = Object.entries(perfMap).map(([cId, agg]) => {
      const camp = campaignLookup[cId];
      return {
        id: cId, name: camp?.name || 'Unknown', status: camp?.status, objective: camp?.objective,
        spend: agg.spend, conversions: agg.conversions,
        roas: agg.spend > 0 ? agg.conversionValue / agg.spend : 0,
        cpc: agg.clicks > 0 ? agg.spend / agg.clicks : 0,
        ctr: agg.impressions > 0 ? (agg.clicks / agg.impressions) * 100 : 0,
      };
    }).sort((a, b) => b.roas - a.roas);

    const objMap = {};
    for (const [cId, agg] of Object.entries(perfMap)) {
      const obj = campaignLookup[cId]?.objective || 'UNKNOWN';
      if (!objMap[obj]) objMap[obj] = { objective: obj, spend: 0, conversions: 0, clicks: 0, impressions: 0 };
      objMap[obj].spend += agg.spend; objMap[obj].conversions += agg.conversions;
      objMap[obj].clicks += agg.clicks; objMap[obj].impressions += agg.impressions;
    }
    const objectiveBreakdown = Object.values(objMap)
      .map(o => ({ ...o, cpc: o.clicks > 0 ? o.spend / o.clicks : 0 }))
      .sort((a, b) => b.spend - a.spend);

    const trends = detectTrends(chartData);

    return NextResponse.json({
      kpis: buildKPIs(current, previous),
      chart: chartData,
      performance: {
        topCampaigns: campaignPerformance.filter(c => c.spend > 0).slice(0, 5),
        bottomCampaigns: campaignPerformance.filter(c => c.spend > 0).slice(-5).reverse(),
      },
      objectiveBreakdown, trends,
      period: { from: dateFrom, to: dateTo, comparisonFrom: compFrom, comparisonTo: compTo, compareMode, breakdown },
    });
  } catch (err) {
    console.error('Analytics overview error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ================================================
// HELPER FUNCTIONS — pure computation, no DB calls
// ================================================

function emptyKPIs() {
  const z = { value: 0, change: 0 };
  return { spend: z, impressions: z, clicks: z, reach: z, conversions: z, conversionValue: z, cpc: z, ctr: z, roas: z, cpm: z, cpa: z, conversionRate: z };
}

function aggregateMetrics(rows) {
  return rows.reduce((acc, r) => ({
    spend: acc.spend + parseFloat(r.spend || 0),
    impressions: acc.impressions + parseInt(r.impressions || 0),
    clicks: acc.clicks + parseInt(r.clicks || 0),
    conversions: acc.conversions + parseFloat(r.conversions || 0),
    conversionValue: acc.conversionValue + parseFloat(r.conversion_value || 0),
    reach: acc.reach + parseInt(r.reach || 0),
  }), { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, reach: 0 });
}

function buildKPIs(c, p) {
  const cpc = c.clicks > 0 ? c.spend / c.clicks : 0;
  const pCpc = p.clicks > 0 ? p.spend / p.clicks : 0;
  const ctr = c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0;
  const pCtr = p.impressions > 0 ? (p.clicks / p.impressions) * 100 : 0;
  const roas = c.spend > 0 ? c.conversionValue / c.spend : 0;
  const pRoas = p.spend > 0 ? p.conversionValue / p.spend : 0;
  return {
    spend: { value: c.spend, change: pctChange(c.spend, p.spend) },
    impressions: { value: c.impressions, change: pctChange(c.impressions, p.impressions) },
    clicks: { value: c.clicks, change: pctChange(c.clicks, p.clicks) },
    reach: { value: c.reach, change: pctChange(c.reach, p.reach) },
    conversions: { value: c.conversions, change: pctChange(c.conversions, p.conversions) },
    conversionValue: { value: c.conversionValue, change: pctChange(c.conversionValue, p.conversionValue) },
    cpc: { value: cpc, change: pctChange(cpc, pCpc) },
    ctr: { value: ctr, change: pctChange(ctr, pCtr) },
    roas: { value: roas, change: pctChange(roas, pRoas) },
  };
}

function buildChartData(rows, breakdown) {
  const map = {};
  for (const r of rows) {
    const key = getBreakdownKey(r.date, breakdown);
    if (!map[key]) map[key] = { date: key, spend: 0, conversions: 0, clicks: 0, impressions: 0, reach: 0, conversionValue: 0 };
    map[key].spend += parseFloat(r.spend || 0);
    map[key].conversions += parseFloat(r.conversions || 0);
    map[key].clicks += parseInt(r.clicks || 0);
    map[key].impressions += parseInt(r.impressions || 0);
    map[key].reach += parseInt(r.reach || 0);
    map[key].conversionValue += parseFloat(r.conversion_value || 0);
  }
  return Object.values(map).map(p => ({
    ...p,
    cpc: p.clicks > 0 ? +(p.spend / p.clicks).toFixed(2) : 0,
    ctr: p.impressions > 0 ? +((p.clicks / p.impressions) * 100).toFixed(2) : 0,
    roas: p.spend > 0 ? +(p.conversionValue / p.spend).toFixed(2) : 0,
  })).sort((a, b) => a.date.localeCompare(b.date));
}

function getBreakdownKey(dateStr, b) {
  if (b === 'month') { const d = new Date(dateStr); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
  if (b === 'week') { const d = new Date(dateStr); const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1); return new Date(d.setDate(diff)).toISOString().split('T')[0]; }
  return dateStr;
}

function detectTrends(chartData) {
  if (chartData.length < 3) return {};
  const trends = {};
  for (const metric of ['spend', 'conversions', 'cpc', 'roas']) {
    const values = chartData.map(d => d[metric]).filter(v => v != null);
    if (values.length < 3) continue;
    const n = values.length, xMean = (n-1)/2, yMean = values.reduce((a,b)=>a+b,0)/n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i-xMean)*(values[i]-yMean); den += (i-xMean)**2; }
    const slope = den ? num/den : 0;
    const pct = yMean ? (slope/yMean)*100 : 0;
    trends[metric] = pct > 5 ? 'increasing' : pct < -5 ? 'decreasing' : 'stable';
  }
  return trends;
}

function getComparisonDates(dateFrom, dateTo, mode) {
  if (mode === 'none') return { compFrom: null, compTo: null };
  const from = new Date(dateFrom), to = new Date(dateTo);
  const days = Math.ceil((to - from) / 86400000);
  if (mode === 'yoy') {
    const cf = new Date(from); cf.setFullYear(cf.getFullYear()-1);
    const ct = new Date(cf); ct.setDate(ct.getDate()+days);
    return { compFrom: cf.toISOString().split('T')[0], compTo: ct.toISOString().split('T')[0] };
  }
  const ct = new Date(from); ct.setDate(ct.getDate()-1);
  const cf = new Date(ct); cf.setDate(cf.getDate()-days);
  return { compFrom: cf.toISOString().split('T')[0], compTo: ct.toISOString().split('T')[0] };
}

function pctChange(c, p) { return p === 0 ? (c > 0 ? 100 : 0) : +((c-p)/p*100).toFixed(1); }
