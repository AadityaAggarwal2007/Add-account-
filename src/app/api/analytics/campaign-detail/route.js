import { NextResponse } from 'next/server';
import { queryOne, queryRows } from '@/lib/db';
import { fetchAdSets, fetchInsights, fetchPeriodReach } from '@/lib/meta-api';

export const dynamic = 'force-dynamic';

// GET /api/analytics/campaign-detail?id=UUID&from=&to=
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const campaignId = searchParams.get('id');
  const dateFrom = searchParams.get('from');
  const dateTo = searchParams.get('to');

  if (!campaignId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  try {
    // Parallel: campaign + account in single JOIN
    const campaign = await queryOne(
      `SELECT c.id, c.external_id, c.name, c.status, c.objective,
              c.daily_budget, c.lifetime_budget, c.meta_account_id,
              ma.access_token, ma.meta_account_id as meta_account_external_id, ma.name as account_name
       FROM campaigns c
       JOIN meta_accounts ma ON c.meta_account_id = ma.id
       WHERE c.id = $1`,
      [campaignId]
    );

    if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    if (!campaign.access_token) return NextResponse.json({ error: 'No access token' }, { status: 400 });

    // Fetch ad sets from Meta API + DB metrics in parallel
    const [adSets, adSetInsights, dbMetrics] = await Promise.all([
      fetchAdSets(campaign.external_id, campaign.access_token).catch(() => []),
      dateFrom && dateTo
        ? fetchInsights(campaign.meta_account_external_id, campaign.access_token, dateFrom, dateTo, 'adset').catch(() => [])
        : Promise.resolve([]),
      dateFrom && dateTo
        ? queryRows(
            `SELECT spend, clicks, impressions, conversions, conversion_value, reach
             FROM metrics WHERE campaign_id = $1 AND entity_type = 'campaign' AND date >= $2 AND date <= $3`,
            [campaignId, dateFrom, dateTo]
          )
        : Promise.resolve([]),
    ]);

    // Merge ad set insights
    const insightMap = {};
    for (const row of adSetInsights) {
      if (!insightMap[row.adSetId]) insightMap[row.adSetId] = { spend: 0, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0, reach: 0 };
      const m = insightMap[row.adSetId];
      m.spend += row.spend; m.clicks += row.clicks; m.impressions += row.impressions;
      m.conversions += row.conversions; m.conversionValue += row.conversionValue; m.reach += row.reach;
    }

    const enrichedAdSets = adSets.map(as => {
      const m = insightMap[as.externalId] || { spend: 0, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0, reach: 0 };
      return {
        ...as, spend: m.spend, clicks: m.clicks, impressions: m.impressions,
        conversions: m.conversions, reach: m.reach, reachEstimated: true,
        cpc: m.clicks > 0 ? m.spend / m.clicks : 0,
        ctr: m.impressions > 0 ? (m.clicks / m.impressions) * 100 : 0,
        roas: m.spend > 0 ? m.conversionValue / m.spend : 0,
      };
    }).sort((a, b) => b.spend - a.spend);

    // Aggregate DB campaign metrics
    let campaignMetrics = { spend: 0, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0, reach: 0 };
    for (const r of dbMetrics) {
      campaignMetrics.spend += parseFloat(r.spend || 0);
      campaignMetrics.clicks += parseInt(r.clicks || 0);
      campaignMetrics.impressions += parseInt(r.impressions || 0);
      campaignMetrics.conversions += parseFloat(r.conversions || 0);
      campaignMetrics.conversionValue += parseFloat(r.conversion_value || 0);
      campaignMetrics.reach += parseInt(r.reach || 0);
    }

    // Deduplicated reach
    if (dateFrom && dateTo) {
      try {
        const campaignReachMap = await fetchPeriodReach(
          campaign.meta_account_external_id, campaign.access_token, dateFrom, dateTo, 'campaign'
        );
        if (campaignReachMap[campaign.external_id] != null) {
          campaignMetrics.reach = campaignReachMap[campaign.external_id];
        }
      } catch (e) {
        console.warn('[CampaignDetail] Deduplicated reach failed, using summed daily:', e.message);
      }
    }

    return NextResponse.json({
      campaign: {
        id: campaign.id, external_id: campaign.external_id, name: campaign.name,
        status: campaign.status, objective: campaign.objective,
        daily_budget: campaign.daily_budget, lifetime_budget: campaign.lifetime_budget,
        meta_account_id: campaign.meta_account_id, accountName: campaign.account_name,
        metrics: {
          ...campaignMetrics,
          cpc: campaignMetrics.clicks > 0 ? campaignMetrics.spend / campaignMetrics.clicks : 0,
          ctr: campaignMetrics.impressions > 0 ? (campaignMetrics.clicks / campaignMetrics.impressions) * 100 : 0,
          roas: campaignMetrics.spend > 0 ? campaignMetrics.conversionValue / campaignMetrics.spend : 0,
        },
      },
      adSets: enrichedAdSets,
    });
  } catch (err) {
    console.error('Campaign detail error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
