import { NextResponse } from 'next/server';
import { queryRows, queryOne } from '@/lib/db';
import { fetchPeriodReach } from '@/lib/meta-api';

export const dynamic = 'force-dynamic';

// GET /api/analytics/campaigns — Optimized campaign table
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
  const searchQuery = searchParams.get('search')?.trim().toLowerCase() || '';
  const performanceTier = searchParams.get('performance');
  const sortBy = searchParams.get('sort') || 'spend';
  const sortOrder = searchParams.get('order') || 'desc';
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '25')));

  try {
    // QUERY 1: All campaigns with account name via JOIN
    const params = [];
    const filters = ['1=1'];
    if (accountId) { params.push(accountId); filters.push(`c.meta_account_id = $${params.length}`); }
    if (searchQuery) { params.push(`%${searchQuery}%`); filters.push(`c.name ILIKE $${params.length}`); }

    const campaigns = await queryRows(
      `SELECT c.id, c.external_id, c.name, c.status, c.objective,
              c.daily_budget, c.lifetime_budget, c.meta_account_id,
              ma.name as account_name, ma.currency
       FROM campaigns c
       LEFT JOIN meta_accounts ma ON c.meta_account_id = ma.id
       WHERE ${filters.join(' AND ')}`,
      params
    );

    if (!campaigns.length) return NextResponse.json({ campaigns: [], pagination: { page, limit, totalCount: 0, totalPages: 0, hasNext: false, hasPrev: false }, summary: {} });

    const campaignIds = campaigns.map(c => c.id);

    // QUERY 2 + 3 in parallel: current + previous period metrics
    const daysDiff = Math.ceil((new Date(dateTo) - new Date(dateFrom)) / 86400000);
    const prevTo = new Date(new Date(dateFrom).getTime() - 86400000).toISOString().split('T')[0];
    const prevFrom = new Date(new Date(dateFrom).getTime() - (daysDiff + 1) * 86400000).toISOString().split('T')[0];

    const [allMetrics, prevMetrics] = await Promise.all([
      queryRows(
        `SELECT campaign_id, spend, impressions, clicks, conversions, conversion_value, reach
         FROM metrics WHERE entity_type = 'campaign' AND campaign_id = ANY($1::uuid[]) AND date >= $2 AND date <= $3`,
        [campaignIds, dateFrom, dateTo]
      ),
      queryRows(
        `SELECT campaign_id, spend, impressions, clicks, conversions, conversion_value
         FROM metrics WHERE entity_type = 'campaign' AND campaign_id = ANY($1::uuid[]) AND date >= $2 AND date <= $3`,
        [campaignIds, prevFrom, prevTo]
      ),
    ]);

    // Aggregate in memory
    const currMap = {}, prevMap = {};
    for (const m of allMetrics) {
      if (!currMap[m.campaign_id]) currMap[m.campaign_id] = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, reach: 0 };
      const a = currMap[m.campaign_id];
      a.spend += parseFloat(m.spend || 0); a.impressions += parseInt(m.impressions || 0);
      a.clicks += parseInt(m.clicks || 0); a.conversions += parseFloat(m.conversions || 0);
      a.conversionValue += parseFloat(m.conversion_value || 0); a.reach += parseInt(m.reach || 0);
    }
    for (const m of prevMetrics) {
      if (!prevMap[m.campaign_id]) prevMap[m.campaign_id] = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
      const a = prevMap[m.campaign_id];
      a.spend += parseFloat(m.spend || 0); a.impressions += parseInt(m.impressions || 0);
      a.clicks += parseInt(m.clicks || 0); a.conversions += parseFloat(m.conversions || 0);
      a.conversionValue += parseFloat(m.conversion_value || 0);
    }

    // Build enriched rows
    const enriched = campaigns.map(c => {
      let curr = currMap[c.id] || { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, reach: 0 };
      const prev = prevMap[c.id] || { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };

      if (c.status === 'PAUSED' && curr.spend < 0.01) {
        curr = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, reach: 0 };
      }
      if (curr.clicks > 0 && curr.spend > 0) {
        const computedCpc = curr.spend / curr.clicks;
        if (computedCpc < 0.005 && curr.clicks > 5) {
          console.warn(`[Campaigns] Data anomaly for "${c.name}": ${curr.clicks} clicks with $${curr.spend.toFixed(2)} spend. Resetting.`);
          curr.clicks = 0; curr.impressions = 0;
        }
      }

      const { spend, clicks, impressions, conversions, conversionValue } = curr;
      return {
        id: c.id, externalId: c.external_id, name: c.name, status: c.status, objective: c.objective,
        dailyBudget: c.daily_budget, lifetimeBudget: c.lifetime_budget,
        accountName: c.account_name || 'Unknown',
        spend, impressions, clicks, conversions, conversionValue, reach: curr.reach, reachEstimated: true,
        cpc: clicks > 0 && spend > 0 ? +(spend / clicks).toFixed(4) : 0,
        ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0,
        roas: spend > 0 ? +(conversionValue / spend).toFixed(4) : 0,
        cpa: conversions > 0 && spend > 0 ? +(spend / conversions).toFixed(2) : 0,
        changes: {
          spend: pctChange(spend, prev.spend),
          clicks: pctChange(clicks, prev.clicks),
          conversions: pctChange(conversions, prev.conversions),
          roas: pctChange(spend > 0 ? conversionValue / spend : 0, prev.spend > 0 ? prev.conversionValue / prev.spend : 0),
        },
        performanceTier: getPerformanceTier({ spend, clicks, conversions, conversionValue, impressions }),
      };
    });

    // Deduplicated reach from Meta API
    try {
      const accountMetaIds = [...new Set(campaigns.map(c => c.meta_account_id))];
      const accounts = await queryRows(
        `SELECT id, meta_account_id, access_token FROM meta_accounts WHERE id = ANY($1::uuid[]) AND is_active = true`,
        [accountMetaIds]
      );
      if (accounts.length) {
        const externalIdMap = {};
        for (const c of campaigns) externalIdMap[c.external_id] = c.id;
        const allCampaignReach = {};
        await Promise.all(accounts.map(async (acc) => {
          const reachMap = await fetchPeriodReach(acc.meta_account_id, acc.access_token, dateFrom, dateTo, 'campaign').catch(() => ({}));
          for (const [metaCampId, reach] of Object.entries(reachMap)) {
            const dbId = externalIdMap[metaCampId];
            if (dbId) allCampaignReach[dbId] = reach;
          }
        }));
        for (const row of enriched) {
          if (allCampaignReach[row.id] != null) { row.reach = allCampaignReach[row.id]; row.reachEstimated = false; }
        }
      }
    } catch (reachErr) {
      console.warn('[Campaigns] Failed to fetch deduplicated campaign reach:', reachErr.message);
    }

    let filtered = enriched;
    if (performanceTier) filtered = filtered.filter(c => c.performanceTier === performanceTier);

    filtered.sort((a, b) => {
      let aVal = a[sortBy], bVal = b[sortBy];
      if (typeof aVal === 'string') return sortOrder === 'desc' ? bVal?.localeCompare(aVal) : aVal?.localeCompare(bVal);
      return sortOrder === 'desc' ? (bVal || 0) - (aVal || 0) : (aVal || 0) - (bVal || 0);
    });

    const totalCount = filtered.length;
    const totalPages = Math.ceil(totalCount / limit);
    const paginated = filtered.slice((page - 1) * limit, page * limit);

    const summary = {
      totalCampaigns: totalCount,
      activeCampaigns: filtered.filter(c => c.status === 'ACTIVE').length,
      totalSpend: filtered.reduce((s, c) => s + c.spend, 0),
      avgRoas: filtered.length > 0 ? +(filtered.reduce((s, c) => s + c.roas, 0) / filtered.length).toFixed(2) : 0,
      totalConversions: filtered.reduce((s, c) => s + c.conversions, 0),
      profitableCampaigns: filtered.filter(c => c.roas >= 1).length,
      losingCampaigns: filtered.filter(c => c.spend > 0 && c.roas < 1).length,
    };

    return NextResponse.json({
      campaigns: paginated,
      pagination: { page, limit, totalCount, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
      summary,
    });
  } catch (err) {
    console.error('Campaigns API error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function getPerformanceTier(m) {
  const roas = m.spend > 0 ? m.conversionValue / m.spend : 0;
  if (m.spend === 0) return 'no_spend';
  if (roas >= 3) return 'top';
  if (roas >= 1) return 'average';
  if (m.conversions === 0 && m.spend > 0) return 'losing';
  return 'bottom';
}

function pctChange(c, p) { return p === 0 ? (c > 0 ? 100 : 0) : +((c - p) / p * 100).toFixed(1); }
