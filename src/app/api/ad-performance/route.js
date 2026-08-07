import { NextResponse } from 'next/server';
import { queryRows } from '@/lib/db';
import { fetchInsights } from '@/lib/meta-api';

const META_GRAPH_URL = 'https://graph.facebook.com/v22.0';

const CONVERSION_PRIORITY = [
  // Website pixel purchases first — matches Meta Ads Manager "Results" column
  'purchase', 'offsite_conversion.fb_pixel_purchase',
  'lead', 'offsite_conversion.fb_pixel_lead',
  'complete_registration', 'offsite_conversion.fb_pixel_complete_registration',
  'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart',
  'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout',
  'onsite_conversion.messaging_conversation_started_7d',
  // omni_purchase last — includes app/offline, inflates vs Meta Ads Manager
  'omni_purchase', 'omni_add_to_cart',
];

// If ANY purchase action exists for an ad, only count purchase types.
// Prevents add_to_cart from being counted for purchase-objective ads with 0 purchases.
const PURCHASE_TYPES = new Set([
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'omni_purchase',
]);

// GET /api/ad-performance?level=campaign|adset|ad&from=&to=&account=
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const level = searchParams.get('level') || 'campaign';
  const dateFrom = searchParams.get('from');
  const dateTo = searchParams.get('to');
  const accountId = searchParams.get('account');

  if (!dateFrom || !dateTo) {
    return NextResponse.json({ error: 'from and to dates required' }, { status: 400 });
  }

  try {
    const accounts = accountId
      ? await queryRows(`SELECT id, meta_account_id, access_token, name, currency FROM meta_accounts WHERE is_active = true AND id = $1`, [accountId])
      : await queryRows(`SELECT id, meta_account_id, access_token, name, currency FROM meta_accounts WHERE is_active = true`);

    if (!accounts.length) return NextResponse.json({ data: [], error: 'No active accounts' });

    if (level === 'campaign') return await handleCampaigns(accounts, dateFrom, dateTo, accountId);
    if (level === 'adset')   return await handleAdSets(accounts, dateFrom, dateTo);
    if (level === 'ad')      return await handleAds(accounts, dateFrom, dateTo);

    return NextResponse.json({ error: 'Invalid level' }, { status: 400 });
  } catch (err) {
    console.error('Ad performance API error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

async function handleCampaigns(accounts, dateFrom, dateTo, accountId) {
  const accountIds = accounts.map(a => a.id);
  const campaigns = accountId
    ? await queryRows(`SELECT id, external_id, name, status, objective, meta_account_id FROM campaigns WHERE meta_account_id = $1`, [accountId])
    : await queryRows(`SELECT id, external_id, name, status, objective, meta_account_id FROM campaigns WHERE meta_account_id = ANY($1::uuid[])`, [accountIds]);

  if (!campaigns.length) return NextResponse.json({ data: [] });

  const campaignIds = campaigns.map(c => c.id);
  const metrics = await queryRows(
    `SELECT campaign_id, spend, clicks, impressions, conversions, conversion_value
     FROM metrics WHERE entity_type = 'campaign' AND campaign_id = ANY($1::uuid[]) AND date >= $2 AND date <= $3`,
    [campaignIds, dateFrom, dateTo]
  );

  const metricsMap = {};
  for (const m of metrics) {
    if (!metricsMap[m.campaign_id]) metricsMap[m.campaign_id] = { spend: 0, conversions: 0, impressions: 0, clicks: 0 };
    const a = metricsMap[m.campaign_id];
    a.spend += parseFloat(m.spend || 0); a.conversions += parseFloat(m.conversions || 0);
    a.impressions += parseInt(m.impressions || 0); a.clicks += parseInt(m.clicks || 0);
  }

  const data = campaigns.map(c => {
    const m = metricsMap[c.id] || { spend: 0, conversions: 0, impressions: 0, clicks: 0 };
    return {
      id: c.id, externalId: c.external_id, name: c.name, status: c.status, entityType: 'campaign', thumbnailUrl: null,
      results: m.conversions,
      cpr: m.conversions > 0 ? +(m.spend / m.conversions).toFixed(2) : 0,
      amountSpent: +m.spend.toFixed(2),
      cpm: m.impressions > 0 ? +((m.spend / m.impressions) * 1000).toFixed(2) : 0,
    };
  }).sort((a, b) => b.amountSpent - a.amountSpent);

  return NextResponse.json({ data });
}

async function handleAdSets(accounts, dateFrom, dateTo) {
  const allData = [];
  await Promise.all(accounts.map(async (account) => {
    try {
      const [insights, adSetStatuses] = await Promise.all([
        fetchInsights(account.meta_account_id, account.access_token, dateFrom, dateTo, 'adset'),
        fetchAccountAdSets(account.meta_account_id, account.access_token),
      ]);
      const statusMap = {};
      for (const as of adSetStatuses) statusMap[as.id] = as.status;

      const adSetRows = {};
      for (const row of insights) {
        if (!adSetRows[row.adSetId]) adSetRows[row.adSetId] = { name: row.adSetName, rows: [] };
        adSetRows[row.adSetId].rows.push(row);
      }
      for (const [adSetId, { name, rows }] of Object.entries(adSetRows)) {
        const agg = aggregateWithConsistentConversions(rows);
        allData.push({
          id: adSetId, externalId: adSetId, name, entityType: 'adset', thumbnailUrl: null,
          status: statusMap[adSetId] || 'UNKNOWN',
          results: agg.conversions,
          cpr: agg.conversions > 0 ? +(agg.spend / agg.conversions).toFixed(2) : 0,
          amountSpent: +agg.spend.toFixed(2),
          cpm: agg.impressions > 0 ? +((agg.spend / agg.impressions) * 1000).toFixed(2) : 0,
        });
      }
    } catch (err) { console.error(`Ad set fetch error for ${account.name}:`, err.message); }
  }));
  allData.sort((a, b) => b.amountSpent - a.amountSpent);
  return NextResponse.json({ data: allData });
}

async function handleAds(accounts, dateFrom, dateTo) {
  const allData = [];
  await Promise.all(accounts.map(async (account) => {
    try {
      const [insights, adDetailsList] = await Promise.all([
        fetchInsights(account.meta_account_id, account.access_token, dateFrom, dateTo, 'ad'),
        fetchAccountAds(account.meta_account_id, account.access_token),
      ]);
      const detailsMap = {};
      for (const ad of adDetailsList) detailsMap[ad.id] = ad;

      const adRows = {};
      for (const row of insights) {
        // Skip ads not in fetchAccountAds (deleted/archived — they exist in historical
        // insights but are not visible in Meta Ads Manager default view)
        if (!detailsMap[row.adId]) continue;
        if (!adRows[row.adId]) adRows[row.adId] = { name: row.adName, rows: [] };
        adRows[row.adId].rows.push(row);
      }
      for (const [adId, { name, rows }] of Object.entries(adRows)) {
        const detail = detailsMap[adId] || {};
        const agg = aggregateWithConsistentConversions(rows);
        allData.push({
          id: adId, externalId: adId, name, entityType: 'ad',
          status: detail.status || 'UNKNOWN',
          thumbnailUrl: detail.thumbnailUrl || null,
          creativeType: detail.creativeType || null,
          results: agg.conversions,
          cpr: agg.conversions > 0 ? +(agg.spend / agg.conversions).toFixed(2) : 0,
          amountSpent: +agg.spend.toFixed(2),
          cpm: agg.impressions > 0 ? +((agg.spend / agg.impressions) * 1000).toFixed(2) : 0,
        });
      }
    } catch (err) { console.error(`Ad fetch error for ${account.name}:`, err.message); }
  }));
  allData.sort((a, b) => b.amountSpent - a.amountSpent);
  return NextResponse.json({ data: allData });
}

function aggregateWithConsistentConversions(rows) {
  let spend = 0, impressions = 0;
  const allActions = [];
  for (const row of rows) {
    spend += row.spend; impressions += row.impressions;
    if (row.rawData?.actions) allActions.push(row.rawData.actions);
  }
  const dominantType = findDominantConversionType(allActions);
  let conversions = 0;
  if (dominantType) {
    for (const actions of allActions) {
      const action = actions.find(a => a.action_type === dominantType);
      if (action) conversions += parseFloat(action.value || '0');
    }
  }
  return { spend, impressions, conversions };
}

function findDominantConversionType(allActionArrays) {
  const typeSet = new Set();
  for (const actions of allActionArrays) for (const a of actions) typeSet.add(a.action_type);

  // If this ad has any purchase-type action, restrict to PIXEL purchases only.
  // Meta Ads Manager "Results" = Website purchases (pixel only, not app/offline).
  // If only omni_purchase exists (app/offline, no pixel), return null → 0 results.
  const hasPurchaseType = [...typeSet].some(t => PURCHASE_TYPES.has(t));
  if (hasPurchaseType) {
    if (typeSet.has('purchase')) return 'purchase';
    if (typeSet.has('offsite_conversion.fb_pixel_purchase')) return 'offsite_conversion.fb_pixel_purchase';
    // Only omni_purchase (app/offline) — Meta shows 0 website purchases → we do too
    return null;
  }

  // No purchase types at all — check other objectives (lead, add_to_cart, etc.)
  for (const type of CONVERSION_PRIORITY) if (typeSet.has(type)) return type;
  return null;
}

async function fetchAccountAdSets(accountId, accessToken) {
  const res = await fetch(`${META_GRAPH_URL}/act_${accountId}/adsets?fields=id,name,status&limit=500&access_token=${accessToken}`);
  if (!res.ok) return [];
  const { data } = await res.json();
  return (data || []).map(a => ({ id: a.id, name: a.name, status: a.status }));
}

async function fetchAccountAds(accountId, accessToken) {
  const allAds = [];
  // Include ALL effective statuses — CAMPAIGN_PAUSED and ADSET_PAUSED are
  // missing from the default response, causing 296→112 ad count discrepancy
  const statuses = encodeURIComponent(JSON.stringify([
    'ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED',
    'PENDING_REVIEW', 'IN_PROCESS', 'DISAPPROVED',
  ]));
  let url = `${META_GRAPH_URL}/act_${accountId}/ads?fields=id,name,status,creative{thumbnail_url,object_type}&effective_status=${statuses}&limit=500&access_token=${accessToken}`;

  // Paginate to get ALL ads (not just first 500)
  while (url) {
    const res = await fetch(url);
    if (!res.ok) break;
    const json = await res.json();
    if (json.data) allAds.push(...json.data);
    url = json.paging?.next || null;
  }

  return allAds.map(ad => ({
    id: ad.id, name: ad.name, status: ad.status,
    thumbnailUrl: ad.creative?.thumbnail_url || null,
    creativeType: ad.creative?.object_type || null,
  }));
}
