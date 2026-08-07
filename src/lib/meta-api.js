// =============================================================
// META MARKETING API WRAPPER — SERVER ONLY
// All Meta API calls go through here. Never import in client code.
// =============================================================

const META_GRAPH_URL = 'https://graph.facebook.com/v22.0';

/**
 * Exchange OAuth code for access token
 */
export async function exchangeCodeForToken(code, redirectUri) {
  // redirectUri must exactly match what was sent in the OAuth dialog

  // Step 1: Exchange code for short-lived token
  const tokenRes = await fetch(
    `${META_GRAPH_URL}/oauth/access_token?` +
    `client_id=${process.env.NEXT_PUBLIC_META_APP_ID}` +
    `&client_secret=${process.env.META_APP_SECRET}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code=${code}`
  );

  if (!tokenRes.ok) {
    const err = await tokenRes.json();
    throw new Error(err.error?.message || 'Failed to exchange code');
  }

  const { access_token } = await tokenRes.json();

  // Step 2: Exchange for long-lived token (~60 days)
  const longRes = await fetch(
    `${META_GRAPH_URL}/oauth/access_token?` +
    `grant_type=fb_exchange_token` +
    `&client_id=${process.env.NEXT_PUBLIC_META_APP_ID}` +
    `&client_secret=${process.env.META_APP_SECRET}` +
    `&fb_exchange_token=${access_token}`
  );

  if (!longRes.ok) {
    const err = await longRes.json();
    throw new Error(err.error?.message || 'Failed to get long-lived token');
  }

  const data = await longRes.json();
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in, // seconds
  };
}

/**
 * Fetch all ad accounts the user has access to
 */
export async function fetchAdAccounts(accessToken) {
  const res = await fetch(
    `${META_GRAPH_URL}/me/adaccounts?` +
    `fields=id,name,account_id,currency,timezone_name,account_status` +
    `&limit=100` +
    `&access_token=${accessToken}`
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || 'Failed to fetch ad accounts');
  }

  const { data } = await res.json();
  return data.map(acct => ({
    metaAccountId: acct.account_id,
    fullId: acct.id, // "act_123456"
    name: acct.name,
    currency: acct.currency,
    timezone: acct.timezone_name,
    isActive: acct.account_status === 1,
  }));
}

/**
 * Fetch campaigns for an ad account
 */
export async function fetchCampaigns(accountId, accessToken) {
  const fields = 'id,name,status,objective,daily_budget,lifetime_budget,buying_type,start_time,stop_time';
  const res = await fetch(
    `${META_GRAPH_URL}/act_${accountId}/campaigns?fields=${fields}&limit=500&access_token=${accessToken}`
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || 'Failed to fetch campaigns');
  }

  const { data } = await res.json();
  return data.map(c => ({
    externalId: c.id,
    name: c.name,
    status: c.status,
    objective: c.objective,
    dailyBudget: c.daily_budget ? parseFloat(c.daily_budget) / 100 : null,
    lifetimeBudget: c.lifetime_budget ? parseFloat(c.lifetime_budget) / 100 : null,
    buyingType: c.buying_type,
    startDate: c.start_time ? c.start_time.split('T')[0] : null,
    endDate: c.stop_time ? c.stop_time.split('T')[0] : null,
    rawData: c,
  }));
}

/**
 * Fetch ad sets for a campaign
 */
export async function fetchAdSets(campaignId, accessToken) {
  const fields = 'id,name,status,daily_budget,lifetime_budget,targeting,optimization_goal,bid_strategy';
  const res = await fetch(
    `${META_GRAPH_URL}/${campaignId}/adsets?fields=${fields}&limit=500&access_token=${accessToken}`
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || 'Failed to fetch ad sets');
  }

  const { data } = await res.json();
  return data.map(a => ({
    externalId: a.id,
    name: a.name,
    status: a.status,
    dailyBudget: a.daily_budget ? parseFloat(a.daily_budget) / 100 : null,
    lifetimeBudget: a.lifetime_budget ? parseFloat(a.lifetime_budget) / 100 : null,
    targetingSummary: a.targeting ? summarizeTargeting(a.targeting) : null,
    optimizationGoal: a.optimization_goal,
    bidStrategy: a.bid_strategy,
    rawData: a,
  }));
}

/**
 * Fetch ads for an ad set
 */
export async function fetchAds(adSetId, accessToken) {
  const fields = 'id,name,status,creative{id,name,thumbnail_url,object_type}';
  const res = await fetch(
    `${META_GRAPH_URL}/${adSetId}/ads?fields=${fields}&limit=500&access_token=${accessToken}`
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || 'Failed to fetch ads');
  }

  const { data } = await res.json();
  return data.map(ad => ({
    externalId: ad.id,
    name: ad.name,
    status: ad.status,
    creativeType: ad.creative?.object_type || null,
    thumbnailUrl: ad.creative?.thumbnail_url || null,
    rawData: ad,
  }));
}

/**
 * Fetch insights (metrics) for an ad account over a date range
 * Handles pagination and multiple conversion action types
 */
export async function fetchInsights(accountId, accessToken, dateFrom, dateTo, level = 'campaign') {
  const fields = [
    'campaign_id', 'campaign_name',
    'adset_id', 'adset_name',
    'ad_id', 'ad_name',
    'impressions', 'clicks', 'inline_link_clicks', 'spend',
    'actions', 'action_values',
    'reach', 'frequency', 'cpc', 'cpm', 'ctr',
  ].join(',');

  const allData = [];
  let url = `${META_GRAPH_URL}/act_${accountId}/insights?` +
    `fields=${fields}` +
    `&level=${level}` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since: dateFrom, until: dateTo }))}` +
    `&time_increment=1` +
    `&limit=500` +
    `&access_token=${accessToken}`;

  // Paginate through all results
  while (url) {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Insights API error:', err);
      throw new Error(err.error?.message || `Insights API failed: ${res.status}`);
    }
    const json = await res.json();
    if (json.data) allData.push(...json.data);
    url = json.paging?.next || null;
  }

  return allData.map(row => {
    // Extract conversions from multiple possible action types
    const conversions = extractConversions(row.actions);
    const conversionValue = extractConversionValue(row.action_values);
    // Use clicks, or fall back to inline_link_clicks
    const clicks = parseInt(row.clicks || row.inline_link_clicks || '0');

    return {
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      adSetId: row.adset_id,
      adSetName: row.adset_name,
      adId: row.ad_id,
      adName: row.ad_name,
      date: row.date_start,
      impressions: parseInt(row.impressions || '0'),
      clicks,
      spend: parseFloat(row.spend || '0'),
      conversions,
      conversionValue,
      reach: parseInt(row.reach || '0'),
      frequency: parseFloat(row.frequency || '0'),
      linkClicks: parseInt(row.inline_link_clicks || '0'),
      rawData: row,
    };
  });
}

/**
 * Fetch DEDUPLICATED reach for a date range (no time_increment = full period).
 * Unlike daily rows where reach per day can overlap, this returns the true
 * unique people reached across the entire period — matching Meta Ads Manager.
 *
 * @param {string} accountId - Meta ad account ID (without act_ prefix)
 * @param {string} accessToken
 * @param {string} dateFrom - YYYY-MM-DD
 * @param {string} dateTo - YYYY-MM-DD
 * @param {string} [level='account'] - 'account' or 'campaign'
 * @returns {Promise<number|Object>} If level='account', returns a single number.
 *   If level='campaign', returns { [campaignId]: reach }
 */
export async function fetchPeriodReach(accountId, accessToken, dateFrom, dateTo, level = 'account') {
  const fields = level === 'campaign'
    ? 'campaign_id,reach'
    : 'reach';

  let url = `${META_GRAPH_URL}/act_${accountId}/insights?` +
    `fields=${fields}` +
    (level === 'campaign' ? '&level=campaign' : '') +
    `&time_range=${encodeURIComponent(JSON.stringify({ since: dateFrom, until: dateTo }))}` +
    `&limit=500` +
    `&access_token=${accessToken}`;

  const allData = [];
  while (url) {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Period reach API error:', err);
      // Return 0/empty on failure — don't break the whole dashboard
      return level === 'campaign' ? {} : 0;
    }
    const json = await res.json();
    if (json.data) allData.push(...json.data);
    url = json.paging?.next || null;
  }

  if (level === 'campaign') {
    const map = {};
    for (const row of allData) {
      map[row.campaign_id] = parseInt(row.reach || '0');
    }
    return map;
  }

  // Account level — single row
  return allData.length > 0 ? parseInt(allData[0].reach || '0') : 0;
}

/**
 * Pause a Meta campaign
 */
export async function pauseCampaign(campaignId, accessToken) {
  const res = await fetch(`${META_GRAPH_URL}/${campaignId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'PAUSED', access_token: accessToken }),
  });
  if (!res.ok) throw new Error('Failed to pause campaign');
  return res.json();
}

/**
 * Enable a Meta campaign
 */
export async function enableCampaign(campaignId, accessToken) {
  const res = await fetch(`${META_GRAPH_URL}/${campaignId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ACTIVE', access_token: accessToken }),
  });
  if (!res.ok) throw new Error('Failed to enable campaign');
  return res.json();
}

/**
 * Update campaign budget (amount in dollars — we convert to cents for Meta)
 */
export async function updateBudget(campaignId, newBudgetDollars, accessToken) {
  const budgetCents = Math.round(newBudgetDollars * 100);
  const res = await fetch(`${META_GRAPH_URL}/${campaignId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ daily_budget: budgetCents, access_token: accessToken }),
  });
  if (!res.ok) throw new Error('Failed to update budget');
  return res.json();
}

/**
 * Pause an ad set
 */
export async function pauseAdSet(adSetId, accessToken) {
  const res = await fetch(`${META_GRAPH_URL}/${adSetId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'PAUSED', access_token: accessToken }),
  });
  if (!res.ok) throw new Error('Failed to pause ad set');
  return res.json();
}

/**
 * Enable an ad set
 */
export async function enableAdSet(adSetId, accessToken) {
  const res = await fetch(`${META_GRAPH_URL}/${adSetId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ACTIVE', access_token: accessToken }),
  });
  if (!res.ok) throw new Error('Failed to enable ad set');
  return res.json();
}

/**
 * Pause an ad
 */
export async function pauseAd(adId, accessToken) {
  const res = await fetch(`${META_GRAPH_URL}/${adId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'PAUSED', access_token: accessToken }),
  });
  if (!res.ok) throw new Error('Failed to pause ad');
  return res.json();
}

/**
 * Enable an ad
 */
export async function enableAd(adId, accessToken) {
  const res = await fetch(`${META_GRAPH_URL}/${adId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ACTIVE', access_token: accessToken }),
  });
  if (!res.ok) throw new Error('Failed to enable ad');
  return res.json();
}

/**
 * Fetch ad creative media (video source URL, full image URL) for preview modal.
 * Called on-demand when user clicks a thumbnail.
 */
export async function fetchAdCreativeMedia(adId, accessToken) {
  // First get the creative ID from the ad
  const adRes = await fetch(
    `${META_GRAPH_URL}/${adId}?fields=creative{id,thumbnail_url,object_type,object_story_spec,asset_feed_spec,video_id,image_url,image_hash}&access_token=${accessToken}`
  );
  if (!adRes.ok) return { type: 'image', url: null };
  const adData = await adRes.json();
  const creative = adData.creative;
  if (!creative) return { type: 'image', url: null };

  // If there's a video_id, fetch the video source URL
  const videoId = creative.video_id
    || creative.object_story_spec?.video_data?.video_id
    || null;
  if (videoId) {
    try {
      const videoRes = await fetch(
        `${META_GRAPH_URL}/${videoId}?fields=source,picture,thumbnails&access_token=${accessToken}`
      );
      if (videoRes.ok) {
        const videoData = await videoRes.json();
        return {
          type: 'video',
          url: videoData.source || null,
          thumbnail: videoData.picture || creative.thumbnail_url || null,
        };
      }
    } catch {}
  }

  // Fallback to image
  const imageUrl = creative.image_url || creative.thumbnail_url || null;
  return { type: 'image', url: imageUrl };
}

// --- Helpers ---

// Conversion action types — STRICT priority order.
// Meta Ads Manager shows "Results" as the FIRST matching type only.
// We use exact matching (no .includes()) to prevent double-counting.
const CONVERSION_PRIORITY = [
  // Website pixel purchases first — matches Meta Ads Manager "Results" column
  // for purchase-objective campaigns (website purchases only, not omni/app)
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'complete_registration',
  'offsite_conversion.fb_pixel_complete_registration',
  'add_to_cart',
  'offsite_conversion.fb_pixel_add_to_cart',
  'initiate_checkout',
  'offsite_conversion.fb_pixel_initiate_checkout',
  'onsite_conversion.messaging_conversation_started_7d',
  // omni_purchase last — includes app/offline, inflates vs Meta Ads Manager
  'omni_purchase',
  'omni_add_to_cart',
  // NOTE: landing_page_view and link_click removed — they inflate results
];

// Purchase-type action names — if ANY of these appear in the actions array
// (even with value 0), we only count purchase types. This prevents falling
// through to add_to_cart/lead for purchase-objective ads that got 0 purchases.
const PURCHASE_TYPES = new Set([
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'omni_purchase',
]);

function extractConversions(actions) {
  if (!actions || !Array.isArray(actions)) return 0;

  // If this is a purchase-objective ad (has any purchase action in the array),
  // ONLY count purchase conversions — matches Meta Ads Manager "Results" column.
  // Without this guard, ads with 0 purchases but 5 add_to_carts would show 5 results.
  const hasPurchaseType = actions.some(a => PURCHASE_TYPES.has(a.action_type));
  const typesToCheck = hasPurchaseType
    ? ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase']
    : CONVERSION_PRIORITY;

  for (const type of typesToCheck) {
    const action = actions.find(a => a.action_type === type);
    if (action) return parseFloat(action.value || '0');
  }
  return 0;
}

function extractConversionValue(actionValues) {
  if (!actionValues || !Array.isArray(actionValues)) return 0;
  for (const type of CONVERSION_PRIORITY) {
    const action = actionValues.find(a => a.action_type === type);
    if (action) return parseFloat(action.value || '0');
  }
  return 0;
}

function summarizeTargeting(targeting) {
  const parts = [];
  if (targeting.age_min || targeting.age_max) {
    parts.push(`Age: ${targeting.age_min || '?'}-${targeting.age_max || '?'}`);
  }
  if (targeting.genders) {
    const g = targeting.genders.map(g => g === 1 ? 'Male' : g === 2 ? 'Female' : 'All');
    parts.push(`Gender: ${g.join(', ')}`);
  }
  if (targeting.geo_locations?.countries) {
    parts.push(`Countries: ${targeting.geo_locations.countries.join(', ')}`);
  }
  return parts.join(' | ') || 'Custom targeting';
}
