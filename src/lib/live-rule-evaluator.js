// =============================================================
// LIVE AD MONITOR v3 — BATCH API + BULK DB + SPEND FILTER
//
// Runs every 60s via cron. Fetches LIVE data from Meta API.
// Evaluates rules. Pauses/resumes ads that breach thresholds.
//
// KEY OPTIMIZATIONS (scales to 5000+ ads):
//  ✓ Meta Batch API  — 50 pause/resume ops in 1 HTTP round trip
//  ✓ Bulk Supabase   — 1 DB call per action type instead of N
//  ✓ Spend filter    — insights only returns spending ads (fewer pages)
//  ✓ Large page size — limit=1000 for status fetch (fewer round trips)
//  ✓ Parallel accts  — all accounts fetched simultaneously
//  ✓ NaN/Infinity guards on all computed metrics
//  ✓ Zero-result handling: CPR=999999 when spend>0 and results=0
//  ✓ Full pagination — handles arbitrarily large ad counts
//  ✓ Kill switch never resumes — permanent pause
//  ✓ Hard rate limit — max 195 Meta API calls/hour (ban prevention)
// =============================================================

import { getSupabaseServer } from '@/lib/supabase-server';

const META_GRAPH_URL = 'https://graph.facebook.com/v22.0';
const META_BATCH_URL = 'https://graph.facebook.com/';

// Max ops per Meta Batch API call (Meta hard limit = 50)
const META_BATCH_SIZE = 50;

// ── Hard rate limit: max Meta API HTTP calls per hour ───────
const RATE_LIMIT_MAX  = 195;   // Hard ceiling — stay well under Meta's 200/hr
const RATE_LIMIT_KEY  = 'meta_api_rate';
const HOUR_MS         = 60 * 60 * 1000;

// In-process counter for the current invocation (fast path)
// Supabase is the source of truth across cron invocations
let _rateSupabase = null; // set at start of each evaluateLiveRules call
let _rateCount    = 0;    // calls made THIS invocation
let _rateBudget   = RATE_LIMIT_MAX; // remaining budget this hour

async function loadRateBudget(supabase) {
  _rateSupabase = supabase;
  try {
    const { data } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', RATE_LIMIT_KEY)
      .single();

    if (data?.value) {
      const { window_start, count } = data.value;
      const age = Date.now() - new Date(window_start).getTime();
      if (age < HOUR_MS) {
        // Still within the same hour window
        _rateBudget = Math.max(0, RATE_LIMIT_MAX - (count || 0));
        _rateCount  = 0;
        console.log(`[RateLimit] Budget loaded: ${_rateBudget} calls remaining this hour (${count || 0} used)`);
        return;
      }
    }
    // New hour window — reset
    _rateBudget = RATE_LIMIT_MAX;
    _rateCount  = 0;
    console.log(`[RateLimit] New hour window — full budget of ${RATE_LIMIT_MAX} calls`);
  } catch {
    // If DB read fails, assume full budget to avoid blocking
    _rateBudget = RATE_LIMIT_MAX;
    _rateCount  = 0;
  }
}

async function saveRateCount(totalUsedThisHour) {
  if (!_rateSupabase) return;
  try {
    await _rateSupabase.from('system_settings').upsert(
      { key: RATE_LIMIT_KEY, value: { window_start: _rateWindowStart, count: totalUsedThisHour }, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  } catch { /* non-critical */ }
}

let _rateWindowStart = null;

async function trackApiCall(label = '') {
  if (_rateBudget <= 0) {
    throw new Error(`[RateLimit] Hard limit reached (${RATE_LIMIT_MAX} calls/hr). Skipping: ${label}`);
  }
  _rateCount++;
  _rateBudget--;
  if (_rateCount % 10 === 0) {
    console.log(`[RateLimit] ${_rateCount} calls this invocation, ${_rateBudget} remaining in hour`);
  }
}

const CONVERSION_PRIORITY = [
  'purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase',
  'lead', 'offsite_conversion.fb_pixel_lead',
  'complete_registration', 'offsite_conversion.fb_pixel_complete_registration',
  'add_to_cart', 'omni_add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart',
  'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout',
  'onsite_conversion.messaging_conversation_started_7d',
];

// Minimum spend before a rule can fire on an entity
const DEFAULT_MIN_SPEND = 0.50;


// =============================================================
// MAIN ENTRY
// =============================================================

export async function evaluateLiveRules() {
  const supabase = getSupabaseServer();
  const startTime = Date.now();

  // ── Load rate budget from DB (persisted across cron invocations) ──
  _rateWindowStart = new Date().toISOString();
  await loadRateBudget(supabase);

  if (_rateBudget <= 0) {
    console.warn(`[LiveMonitor] ⛔ Rate limit hit — skipping cycle (${RATE_LIMIT_MAX} calls/hr cap)`);
    return { evaluated: 0, message: `Rate limit reached (${RATE_LIMIT_MAX}/hr). Resets next hour.`, rateLimited: true };
  }

  // ── Load active rules (ad + ad_set scope only) ─────────────
  const { data: rules, error } = await supabase
    .from('automation_rules')
    .select('*')
    .eq('is_active', true)
    .in('scope', ['ad', 'ad_set']);

  if (error) throw error;
  if (!rules?.length) return { evaluated: 0, message: 'No active ad/ad-set rules' };

  // ── Get all accounts with tokens ───────────────────────────
  const { data: accounts } = await supabase
    .from('meta_accounts')
    .select('id, meta_account_id, access_token, name')
    .eq('is_active', true);

  if (!accounts?.length) return { evaluated: 0, message: 'No active accounts' };

  // ── Load currently auto-paused entities ────────────────────
  const { data: pausedEntities } = await supabase
    .from('automation_paused_ads')
    .select('*')
    .eq('is_paused', true);

  const pausedMap = {};
  for (const p of (pausedEntities || [])) {
    pausedMap[p.ad_external_id] = p;
  }

  // ── Cache for live data fetches by scope and period ────────
  const liveDataCache = {};
  const checkedEntities = new Set();

  async function getLiveDataForScopeAndPeriod(scope, period) {
    const cacheKey = `${scope}_${period}`;
    if (liveDataCache[cacheKey]) return liveDataCache[cacheKey];

    const dataMap = {};
    const type = scope === 'ad' ? 'ads' : 'adsets';
    const insightsLevel = scope === 'ad' ? 'ad' : 'adset';

    await Promise.all(accounts.map(async (account) => {
      try {
        const [insights, statuses] = await Promise.all([
          fetchAllLiveInsights(account.meta_account_id, account.access_token, insightsLevel, period),
          fetchEntityStatuses(account.meta_account_id, account.access_token, type),
        ]);
        mergeInsightsAndStatuses(insights, statuses, dataMap, account);
      } catch (err) {
        console.error(`[LiveMonitor] Failed to fetch for ${account.name} (${scope}, ${period}):`, err.message);
      }
    }));

    liveDataCache[cacheKey] = dataMap;
    return dataMap;
  }

  // ── Evaluate each rule ─────────────────────────────────────
  const results = [];

  for (const rule of rules) {
    try {
      const period = rule.conditions?.[0]?.period || 'today';
      const dataMap = await getLiveDataForScopeAndPeriod(rule.scope, period);

      // Record which entities were checked
      for (const entityId of Object.keys(dataMap)) {
        checkedEntities.add(`${rule.scope}_${entityId}`);
      }

      const ruleResults = await evaluateRuleAgainstLiveData(supabase, rule, dataMap, pausedMap);
      results.push({ rule: rule.name, ruleId: rule.id, scope: rule.scope, ...ruleResults });
    } catch (err) {
      console.error(`[LiveMonitor] Rule "${rule.name}" error:`, err.message);
      results.push({ rule: rule.name, error: err.message });
    }
  }

  const elapsed = Date.now() - startTime;
  const totalPaused  = results.reduce((s, r) => s + (r.paused  || 0), 0);
  const totalResumed = results.reduce((s, r) => s + (r.resumed || 0), 0);
  const totalSkipped = results.reduce((s, r) => s + (r.skippedMinSpend || 0), 0);

  // ── Persist updated rate count back to DB ────────────────────
  const { data: prevRate } = await supabase
    .from('system_settings').select('value').eq('key', RATE_LIMIT_KEY).single();
  const prevCount = prevRate?.value?.count || 0;
  const prevWindowStart = prevRate?.value?.window_start;
  const windowAge = prevWindowStart ? Date.now() - new Date(prevWindowStart).getTime() : HOUR_MS + 1;
  const usedThisHour = windowAge < HOUR_MS ? prevCount + _rateCount : _rateCount;
  await saveRateCount(usedThisHour);
  console.log(`[RateLimit] Saved: ${usedThisHour}/${RATE_LIMIT_MAX} calls used this hour`);

  console.log(
    `[LiveMonitor] Done in ${elapsed}ms — ` +
    `${checkedEntities.size} unique entities evaluated across ${rules.length} rules | ` +
    `${totalPaused} paused, ${totalResumed} resumed, ${totalSkipped} skipped`
  );

  const diagnostics = {};
  for (const r of results) {
    if (r._breaching?.length) {
      diagnostics[r.rule] = {
        totalBreaching: r._breaching.length,
        breachingAds: r._breaching.slice(0, 20),
        failedPauses: r._failedPauses || [],
      };
    }
  }

  return {
    evaluated: checkedEntities.size,
    rules: rules.length,
    paused: totalPaused,
    resumed: totalResumed,
    skipped: totalSkipped,
    elapsed_ms: elapsed,
    api_calls_this_hour: usedThisHour,
    api_budget_remaining: RATE_LIMIT_MAX - usedThisHour,
    diagnostics,
    results: results.map(r => ({
      rule: r.rule, ruleId: r.ruleId, scope: r.scope,
      paused: r.paused, resumed: r.resumed,
      checked: r.checked, skippedMinSpend: r.skippedMinSpend,
      error: r.error,
    })),
  };
}


// =============================================================
// RULE EVALUATION — Classify then Batch Act
// =============================================================

async function evaluateRuleAgainstLiveData(supabase, rule, liveData, pausedMap) {
  let paused = 0, resumed = 0, skippedMinSpend = 0;
  let checked = 0, skippedNotActive = 0;
  const breachingAds = [];
  const failedPauses = [];

  const conditions = rule.conditions || [];
  if (!conditions.length) return { paused, resumed, skippedMinSpend, checked };

  const minSpend    = parseFloat(rule.min_spend_threshold) || DEFAULT_MIN_SPEND;
  const isKillSwitch = rule.action_type === 'kill_switch';

  // ── PASS 1: Classify every entity — pure CPU, no I/O ──────
  const toPause  = [];
  const toResume = [];

  for (const [entityId, entity] of Object.entries(liveData)) {
    if (rule.target_external_ids?.length && !rule.target_external_ids.includes(entityId)) continue;

    checked++;
    const isPausedByUs = !!pausedMap[entityId];

    // ── MIN SPEND GUARD ──────────────────────────────────────────────────────
    // Skip low-spend ads to avoid false positives on brand new ads.
    // EXCEPTION: if spend > $0 AND results = 0 → always evaluate.
    //   "Spent any money, got zero conversions" must ALWAYS trigger — regardless
    //   of spend amount. The min-spend guard was blocking these exact ads.
    const spendingWithZeroResults = entity.spend > 0 && entity.results === 0;
    if (entity.spend < minSpend && !isPausedByUs && !spendingWithZeroResults) {
      skippedMinSpend++;
      continue;
    }

    const allConditionsMet = conditions.every(cond => {
      const value = getMetricValue(entity, cond.metric);
      return evaluateCondition(value, cond.operator, parseFloat(cond.value));
    });

    if (allConditionsMet && !isPausedByUs) {
      breachingAds.push({ id: entityId, name: entity.entityName, cpr: entity.cpr, spend: entity.spend, results: entity.results, status: entity.status });
      if (entity.status !== 'ACTIVE') { skippedNotActive++; continue; }
      toPause.push({ entityId, entity });

    } else if (!allConditionsMet && isPausedByUs && !isKillSwitch) {
      const pauseRecord = pausedMap[entityId];
      if (pauseRecord.rule_id !== rule.id) continue;
      toResume.push({ entityId, entity });
    }
  }

  // ── PASS 2: Batch PAUSE via Meta Batch API ─────────────────
  // Meta Batch API: 50 ops per HTTP call — far fewer round trips than individual calls
  if (toPause.length > 0) {
    const { succeeded: pauseOk, failed: pauseFail } = await metaBatchAction(toPause, 'PAUSED');

    // Bulk save all tracking + logs in 3 DB calls (not N×4)
    if (pauseOk.length > 0) {
      await bulkSavePauses(supabase, rule, pauseOk, isKillSwitch);
      paused = pauseOk.length;

      await supabase.from('automation_rules')
        .update({ trigger_count: (rule.trigger_count || 0) + paused, last_triggered_at: new Date().toISOString() })
        .eq('id', rule.id);

      console.log(`[LiveMonitor] ⏸️  PAUSED ${paused} ${rule.scope}s via Batch API`);
    }

    for (const { entityId, entity, error } of pauseFail) {
      failedPauses.push({ id: entityId, name: entity.entityName, error });
      try {
        await supabase.from('automation_logs').insert(buildLogRow(rule, entityId, entity, 'failed', error));
      } catch {}
      // If the ad no longer exists on Meta (deleted), remove it from paused tracking
      // so we stop retrying it on every cron run
      const isDeleted = error && (
        error.includes('does not exist') ||
        error.includes('cannot be loaded due to missing permissions') ||
        error.includes('Object with ID')
      );
      if (isDeleted) {
        try {
          await supabase.from('automation_paused_ads')
            .delete()
            .eq('ad_external_id', entityId);
          console.log(`[LiveMonitor] Removed deleted/inaccessible ad from tracking: ${entityId}`);
        } catch {}
      }
    }
  }

  // ── PASS 3: Batch RESUME via Meta Batch API ────────────────
  if (toResume.length > 0) {
    const { succeeded: resumeOk } = await metaBatchAction(toResume, 'ACTIVE');

    if (resumeOk.length > 0) {
      await bulkSaveResumes(supabase, rule, resumeOk);
      resumed = resumeOk.length;
      console.log(`[LiveMonitor] ▶️  RESUMED ${resumed} ${rule.scope}s via Batch API`);
    }
  }

  return { paused, resumed, skippedMinSpend, checked, skippedNotActive, _breaching: breachingAds, _failedPauses: failedPauses };
}


// =============================================================
// META BATCH API — Up to 50 ops in 1 HTTP call
// =============================================================

/**
 * Pause or enable a list of entities using Meta Graph Batch API.
 * Groups by access token (different accounts have different tokens).
 * Sends up to 50 operations per HTTP call instead of 1 per call.
 *
 * Speedup: 500 ops = 10 HTTP calls instead of 500 individual calls.
 */
async function metaBatchAction(entities, targetStatus) {
  // Group by access token — each account needs its own token
  const byToken = new Map();
  for (const { entityId, entity } of entities) {
    if (!byToken.has(entity.accessToken)) byToken.set(entity.accessToken, []);
    byToken.get(entity.accessToken).push({ entityId, entity });
  }

  const succeeded = [];
  const failed    = [];

  for (const [token, group] of byToken) {
    // Process in chunks of META_BATCH_SIZE (50)
    for (let i = 0; i < group.length; i += META_BATCH_SIZE) {
      const chunk = group.slice(i, i + META_BATCH_SIZE);

      try {
        const batchPayload = chunk.map(({ entityId }) => ({
          method: 'POST',
          relative_url: `v22.0/${entityId}`,
          body: `status=${targetStatus}`,
        }));

        // One HTTP round trip for up to 50 operations
        const batchResults = await retryWithBackoff(async () => {
          await trackApiCall(`batch ${targetStatus} — ${chunk.length} ops`);
          const res = await fetch(META_BATCH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: token, batch: batchPayload }),
          });
          if (!res.ok) throw new Error(`Meta Batch API HTTP ${res.status}`);
          const data = await res.json();
          if (!Array.isArray(data)) throw new Error('Meta Batch API returned non-array response');
          return data;
        });

        // Classify each result
        for (let j = 0; j < chunk.length; j++) {
          const { entityId, entity } = chunk[j];
          const result = batchResults[j];

          if (result && result.code >= 200 && result.code < 300) {
            succeeded.push({ entityId, entity });
          } else {
            let errMsg = `HTTP ${result?.code || 'unknown'}`;
            try {
              const errBody = JSON.parse(result?.body || '{}');
              errMsg = errBody.error?.message || errMsg;
            } catch {}
            failed.push({ entityId, entity, error: errMsg });
            console.error(`[LiveMonitor] Batch ${targetStatus} failed for ${entityId}: ${errMsg}`);
          }
        }
      } catch (err) {
        // Entire chunk failed (network/auth error)
        console.error(`[LiveMonitor] Batch chunk failed:`, err.message);
        for (const { entityId, entity } of chunk) {
          failed.push({ entityId, entity, error: err.message });
        }
      }
    }
  }

  return { succeeded, failed };
}


// =============================================================
// BULK SUPABASE OPERATIONS — 3 DB calls per action type, not N×4
// =============================================================

async function bulkSavePauses(supabase, rule, entities, isKillSwitch) {
  const now = new Date().toISOString();
  const ids  = entities.map(e => e.entityId);

  // 1. Remove stale rows for these entities
  await supabase.from('automation_paused_ads').delete().in('ad_external_id', ids);

  // 2. Bulk insert paused tracking
  await supabase.from('automation_paused_ads').insert(
    entities.map(({ entityId, entity }) => ({
      ad_external_id:  entityId,
      ad_name:         entity.entityName,
      rule_id:         rule.id,
      rule_name:       rule.name,
      reason:          isKillSwitch ? 'kill_switch' : 'threshold',
      metric_snapshot: buildSnapshot(entity),
      paused_at:       now,
      resumed_at:      null,
      is_paused:       true,
    }))
  );

  // 3. Bulk insert automation logs
  await supabase.from('automation_logs').insert(
    entities.map(({ entityId, entity }) => buildLogRow(rule, entityId, entity, 'executed'))
  );

  // 4. Bulk insert notifications
  await supabase.from('notifications').insert(
    entities.map(({ entityId, entity }) => ({
      type:     'automation_fired',
      title:    `⏸️ Auto-Paused: ${entity.entityName}`,
      message:  buildNotificationMessage(rule, entity),
      severity: 'warning',
      metadata: { rule_id: rule.id, entity_id: entityId, action: 'paused' },
    }))
  );
}

async function bulkSaveResumes(supabase, rule, entities) {
  const now = new Date().toISOString();
  const ids  = entities.map(e => e.entityId);

  // 1. Mark as resumed in bulk
  await supabase.from('automation_paused_ads')
    .update({ is_paused: false, resumed_at: now })
    .in('ad_external_id', ids)
    .eq('is_paused', true);

  // 2. Bulk insert logs
  await supabase.from('automation_logs').insert(
    entities.map(({ entityId, entity }) => buildLogRow(rule, entityId, entity, 'executed', null, 'enable_ad'))
  );

  // 3. Bulk insert notifications
  await supabase.from('notifications').insert(
    entities.map(({ entityId, entity }) => ({
      type:     'automation_fired',
      title:    `▶️ Auto-Resumed: ${entity.entityName}`,
      message:  buildNotificationMessage(rule, entity),
      severity: 'info',
      metadata: { rule_id: rule.id, entity_id: entityId, action: 'resumed' },
    }))
  );
}


// =============================================================
// METRICS — Extract values with NaN/Infinity guards
// =============================================================

function getMetricValue(entity, metric) {
  switch (metric) {
    case 'spend':                          return entity.spend       || 0;
    case 'cpr': case 'cost_per_result':    return entity.cpr         || 0;
    case 'results': case 'conversions':    return entity.results     || 0;
    case 'impressions':                    return entity.impressions  || 0;
    case 'clicks':                         return entity.clicks       || 0;
    case 'cpc':                            return entity.cpc          || 0;
    case 'ctr':                            return entity.ctr          || 0;
    case 'cpm':                            return entity.cpm          || 0;
    default:                               return 0;
  }
}

function evaluateCondition(actual, operator, expected) {
  if (isNaN(actual) || isNaN(expected)) return false;
  switch (operator) {
    case '>':           return actual >  expected;
    case '<':           return actual <  expected;
    case '>=':          return actual >= expected;
    case '<=':          return actual <= expected;
    case '=': case '==': return actual === expected;
    case '!=':          return actual !== expected;
    default:            return false;
  }
}


// =============================================================
// RETRY — Exponential backoff (1s, 2s, 4s)
// =============================================================

async function retryWithBackoff(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt - 1) * 1000;
      console.warn(`[LiveMonitor] Retry ${attempt}/${maxRetries} in ${delay}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}


// =============================================================
// META API — Full pagination data fetchers
// =============================================================

/**
 * Merge insights + statuses into a single data map.
 * Insights: ads that spent money today.
 * Statuses: ALL active/paused ads (for resume check on zero-spend ads).
 */
function mergeInsightsAndStatuses(insights, statuses, dataMap, account) {
  for (const item of insights) {
    dataMap[item.entityId] = {
      ...item,
      status:      statuses[item.entityId]?.status || 'UNKNOWN',
      accountId:   account.meta_account_id,
      accessToken: account.access_token,
    };
  }

  // Add zero-spend entities (exist in status but not in insights today)
  // Critical for resume logic: we need to evaluate paused ads even if they spent $0
  for (const [entityId, info] of Object.entries(statuses)) {
    if (!dataMap[entityId]) {
      dataMap[entityId] = {
        entityId, entityName: info.name || entityId,
        spend: 0, results: 0, cpr: 0, impressions: 0, clicks: 0,
        cpc: 0, ctr: 0, cpm: 0,
        status:      info.status || 'UNKNOWN',
        accountId:   account.meta_account_id,
        accessToken: account.access_token,
      };
    }
  }
}

/**
 * Helper to calculate start and end dates for a given period in IST.
 */
function getDateRangeForPeriod(period) {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  const todayStr = new Date(istMs).toISOString().split('T')[0];

  if (period === 'today') {
    return { since: todayStr, until: todayStr };
  }
  
  if (period === 'yesterday') {
    const yesterday = new Date(istMs - (24 * 60 * 60 * 1000)).toISOString().split('T')[0];
    return { since: yesterday, until: yesterday };
  }

  let days = 1;
  if (period === 'last_3_days') days = 3;
  else if (period === 'last_7_days') days = 7;
  else if (period === 'last_14_days') days = 14;
  else if (period === 'last_30_days') days = 30;

  const sinceDate = new Date(istMs - ((days - 1) * 24 * 60 * 60 * 1000)).toISOString().split('T')[0];
  return { since: sinceDate, until: todayStr };
}

/**
 * Fetch insights for a given level and period — ONLY for entities with spend > 0.
 * The spend filter dramatically reduces pages fetched for large accounts.
 */
async function fetchAllLiveInsights(accountId, accessToken, level = 'ad', period = 'today') {
  const { since, until } = getDateRangeForPeriod(period);

  const idField   = level === 'ad' ? 'ad_id'    : 'adset_id';
  const nameField = level === 'ad' ? 'ad_name'  : 'adset_name';

  const fields    = `${idField},${nameField},spend,impressions,clicks,actions`;
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));

  // SPEND FILTER: only fetch entities that have spent money in the period.
  const spendFilter = encodeURIComponent(
    JSON.stringify([{ field: 'spend', operator: 'GREATER_THAN', value: '0' }])
  );

  let url = `${META_GRAPH_URL}/act_${accountId}/insights?` +
    `fields=${fields}` +
    `&level=${level}` +
    `&time_range=${timeRange}` +
    `&filtering=${spendFilter}` +
    `&limit=500` +
    `&access_token=${accessToken}`;

  const allRows = [];

  while (url) {
    await trackApiCall(`insights page — ${accountId} ${level} ${period}`);
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Insights failed: ${res.status}`);
    }
    const json = await res.json();
    if (json.data?.length) allRows.push(...json.data);
    url = json.paging?.next || null;
  }

  return allRows.map(row => {
    const spend       = parseFloat(row.spend || '0');
    const impressions = parseInt(row.impressions || '0');
    const clicks      = parseInt(row.clicks || '0');
    const results     = extractConversions(row.actions);

    const cpc = clicks      > 0 ? +(spend / clicks).toFixed(4)              : 0;
    const ctr = impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0;
    const cpm = impressions > 0 ? +((spend / impressions) * 1000).toFixed(4) : 0;

    // CPR: If spending but 0 results → 999999 (triggers "cpr > X" rules correctly)
    // If 0 spend → 0 (won't trigger any rule, handled by min_spend guard)
    const cpr = results > 0 ? +(spend / results).toFixed(2) : (spend > 0 ? 999999 : 0);

    return { entityId: row[idField], entityName: row[nameField], spend, impressions, clicks, results, cpc, ctr, cpm, cpr };
  });
}

/**
 * Fetch all entity statuses — FULL PAGINATION with limit=1000.
 * Larger limit = fewer round trips for large ad counts.
 */
async function fetchEntityStatuses(accountId, accessToken, type = 'ads') {
  const statusFilter = encodeURIComponent(
    JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }])
  );
  let url = `${META_GRAPH_URL}/act_${accountId}/${type}?fields=id,name,status&filtering=${statusFilter}&limit=1000&access_token=${accessToken}`;
  const map = {};

  while (url) {
    await trackApiCall(`status page — ${accountId} ${type}`);
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`[LiveMonitor] fetchEntityStatuses failed for ${type}: ${res.status}`, err);
      return map; // Don't crash on status fetch failure — degrade gracefully
    }
    const json = await res.json();
    for (const entity of (json.data || [])) {
      map[entity.id] = { status: entity.status, name: entity.name };
    }
    url = json.paging?.next || null;
  }

  return map;
}


// =============================================================
// UTILITIES
// =============================================================

function extractConversions(actions) {
  if (!actions || !Array.isArray(actions)) return 0;
  for (const type of CONVERSION_PRIORITY) {
    const action = actions.find(a => a.action_type === type);
    if (action) return parseFloat(action.value || '0');
  }
  return 0;
}

function buildSnapshot(entity) {
  return {
    spend: entity.spend, results: entity.results, cpr: entity.cpr,
    cpc: entity.cpc, ctr: entity.ctr, cpm: entity.cpm,
    impressions: entity.impressions, clicks: entity.clicks,
    evaluated_at: new Date().toISOString(),
  };
}

function buildLogRow(rule, entityId, entity, status, errorMessage = null, actionType = null) {
  return {
    rule_id:            rule.id,
    rule_name:          rule.name,
    entity_type:        rule.scope,
    entity_id:          null,
    entity_external_id: entityId,
    entity_name:        entity.entityName,
    action_type:        actionType || (status === 'executed' ? 'pause_ad' : rule.action_type),
    action_params:      {},
    condition_snapshot: buildSnapshot(entity),
    status,
    error_message:      errorMessage,
  };
}

function buildNotificationMessage(rule, entity) {
  const parts = [`Rule "${rule.name}"`];
  if (entity.cpr > 0 && entity.cpr < 999999) parts.push(`CPR: $${entity.cpr.toFixed(2)}`);
  if (entity.results === 0 && entity.spend > 0) parts.push('Results: 0 (no conversions)');
  parts.push(`Spend: $${entity.spend.toFixed(2)}`);
  return parts.join(' — ');
}
