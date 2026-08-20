// =============================================================
// LIVE AD MONITOR v3 — BATCH API + BULK DB + SPEND FILTER
//
// Runs every 60s via cron. Fetches LIVE data from Meta API.
// Evaluates rules. Pauses/resumes ads that breach thresholds.
//
// KEY OPTIMIZATIONS (scales to 5000+ ads):
//  ✓ Meta Batch API  — 50 pause/resume ops in 1 HTTP round trip
//  ✓ Bulk pg         — 1 DB call per action type instead of N
//  ✓ Spend filter    — insights only returns spending ads (fewer pages)
//  ✓ Large page size — limit=1000 for status fetch (fewer round trips)
//  ✓ Parallel accts  — all accounts fetched simultaneously
//  ✓ NaN/Infinity guards on all computed metrics
//  ✓ Zero-result handling: CPR=999999 when spend>0 and results=0
//  ✓ Full pagination — handles arbitrarily large ad counts
//  ✓ Kill switch never resumes — permanent pause
//  ✓ Hard rate limit — max 195 Meta API calls/hour (ban prevention)
// =============================================================

import { query, queryOne, queryRows, withTransaction } from '@/lib/db';
import { extractConversions } from '@/lib/meta-api';

const META_GRAPH_URL = 'https://graph.facebook.com/v22.0';
const META_BATCH_URL = 'https://graph.facebook.com/';

// Max ops per Meta Batch API call (Meta hard limit = 50)
const META_BATCH_SIZE = 50;

// ── Hard rate limit: max Meta API HTTP calls per hour ───────
// Uses atomic DB operations (SELECT FOR UPDATE) so PM2 cluster workers coordinate.
const RATE_LIMIT_MAX  = 195;
const RATE_LIMIT_KEY  = 'meta_api_rate';
const HOUR_MS         = 60 * 60 * 1000;

let _rateCount    = 0;
let _rateBudget   = RATE_LIMIT_MAX;

async function loadRateBudget() {
  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT value FROM system_settings WHERE key = $1 FOR UPDATE`,
        [RATE_LIMIT_KEY]
      );
      const row = rows[0];

      if (row?.value) {
        const { window_start, count } = row.value;
        const age = Date.now() - new Date(window_start).getTime();
        if (age < HOUR_MS) {
          return { budget: Math.max(0, RATE_LIMIT_MAX - (count || 0)), count: count || 0 };
        }
      }
      // New hour window — reset counter atomically
      const now = new Date().toISOString();
      await client.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [RATE_LIMIT_KEY, JSON.stringify({ window_start: now, count: 0 })]
      );
      return { budget: RATE_LIMIT_MAX, count: 0 };
    });

    _rateBudget = result.budget;
    _rateCount  = 0;
    console.log(`[RateLimit] Budget loaded: ${_rateBudget} calls remaining this hour (${result.count} used)`);
  } catch {
    _rateBudget = RATE_LIMIT_MAX;
    _rateCount  = 0;
  }
}

async function saveRateCount() {
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT value FROM system_settings WHERE key = $1 FOR UPDATE`,
        [RATE_LIMIT_KEY]
      );
      const existing = rows[0]?.value || {};
      const windowStart = existing.window_start || new Date().toISOString();
      const age = Date.now() - new Date(windowStart).getTime();
      const prevCount = age < HOUR_MS ? (existing.count || 0) : 0;
      const newWindowStart = age < HOUR_MS ? windowStart : new Date().toISOString();
      const totalUsed = prevCount + _rateCount;

      await client.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [RATE_LIMIT_KEY, JSON.stringify({ window_start: newWindowStart, count: totalUsed })]
      );
    });
  } catch { /* non-critical */ }
}

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

const DEFAULT_MIN_SPEND = 0.50;

// Cooldown: don't resume an ad until this many minutes after it was paused.
// Prevents flip-flopping where an ad is paused, spend stops, conditions clear,
// and it gets immediately resumed only to breach again next cycle.
const RESUME_COOLDOWN_MINUTES = 60;


// =============================================================
// MAIN ENTRY
// =============================================================

export async function evaluateLiveRules() {
  const startTime = Date.now();

  _rateWindowStart = new Date().toISOString();
  await loadRateBudget();

  // Reserve 10 calls so there's always budget left for a pause action
  const RESERVE_BUDGET = 10;
  if (_rateBudget <= RESERVE_BUDGET) {
    console.warn(`[LiveMonitor] ⛔ Budget too low (${_rateBudget} remaining, reserve=${RESERVE_BUDGET}) — skipping cycle`);
    return { evaluated: 0, message: `Budget too low (${_rateBudget}/${RATE_LIMIT_MAX}). Reserving for actions.`, rateLimited: true };
  }

  // Load active rules (ad + ad_set scope only)
  const rules = await queryRows(
    `SELECT * FROM automation_rules
     WHERE is_active = true AND scope = ANY($1::text[])
     ORDER BY created_at ASC`,
    [['ad', 'ad_set']]
  );

  if (!rules.length) return { evaluated: 0, message: 'No active ad/ad-set rules' };

  // Get all accounts with tokens
  const accounts = await queryRows(
    `SELECT id, meta_account_id, access_token, name
     FROM meta_accounts
     WHERE is_active = true`
  );

  if (!accounts.length) return { evaluated: 0, message: 'No active accounts' };

  // Load currently auto-paused entities
  const pausedEntities = await queryRows(
    `SELECT * FROM automation_paused_ads WHERE is_paused = true`
  );

  const pausedMap = {};
  for (const p of pausedEntities) {
    pausedMap[p.ad_external_id] = p;
  }

  // Cache for live data fetches by scope and period
  const liveDataCache = {};
  const statusCache = {};
  const checkedEntities = new Set();

  async function getStatusesForScope(scope) {
    if (statusCache[scope]) return statusCache[scope];
    const type = scope === 'ad' ? 'ads' : 'adsets';
    const allStatuses = {};

    await Promise.all(accounts.map(async (account) => {
      try {
        const statuses = await fetchEntityStatuses(account.meta_account_id, account.access_token, type);
        for (const [id, info] of Object.entries(statuses)) {
          allStatuses[id] = { ...info, accountId: account.meta_account_id, accessToken: account.access_token };
        }
      } catch (err) {
        console.error(`[LiveMonitor] Failed to fetch statuses for ${account.name} (${scope}):`, err.message);
      }
    }));

    statusCache[scope] = allStatuses;
    return allStatuses;
  }

  async function getLiveDataForScopeAndPeriod(scope, period) {
    const cacheKey = `${scope}_${period}`;
    if (liveDataCache[cacheKey]) return liveDataCache[cacheKey];

    const dataMap = {};
    const insightsLevel = scope === 'ad' ? 'ad' : 'adset';

    // Fetch statuses once per scope (cached), insights per period
    const statuses = await getStatusesForScope(scope);

    await Promise.all(accounts.map(async (account) => {
      try {
        const insights = await fetchAllLiveInsights(account.meta_account_id, account.access_token, insightsLevel, period);
        mergeInsightsAndStatuses(insights, statuses, dataMap, account);
      } catch (err) {
        console.error(`[LiveMonitor] Failed to fetch for ${account.name} (${scope}, ${period}):`, err.message);
      }
    }));

    liveDataCache[cacheKey] = dataMap;
    return dataMap;
  }

  // Evaluate each rule — fetch data for ALL periods used by the rule's conditions
  const results = [];

  for (const rule of rules) {
    try {
      const conditions = rule.conditions || [];
      const periods = [...new Set(conditions.map(c => c.period || 'today'))];

      // Fetch data for every period this rule needs
      const periodDataMaps = {};
      for (const period of periods) {
        const dataMap = await getLiveDataForScopeAndPeriod(rule.scope, period);
        periodDataMaps[period] = dataMap;

        for (const entityId of Object.keys(dataMap)) {
          checkedEntities.add(`${rule.scope}_${entityId}`);
        }
      }

      // Use the primary period (first condition) for spend filtering and entity enumeration
      const primaryPeriod = periods[0];
      const primaryDataMap = periodDataMaps[primaryPeriod];

      const ruleResults = await evaluateRuleAgainstLiveData(rule, primaryDataMap, pausedMap, periodDataMaps);
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

  // Persist updated rate count atomically (safe with PM2 cluster mode)
  await saveRateCount();
  console.log(`[RateLimit] Saved: ${_rateCount} calls this invocation, budget remaining: ${_rateBudget}`);

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
    api_calls_this_invocation: _rateCount,
    api_budget_remaining: _rateBudget,
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

async function evaluateRuleAgainstLiveData(rule, liveData, pausedMap, periodDataMaps = null) {
  let paused = 0, resumed = 0, skippedMinSpend = 0;
  let checked = 0, skippedNotActive = 0;
  const breachingAds = [];
  const failedPauses = [];

  const conditions = rule.conditions || [];
  if (!conditions.length) return { paused, resumed, skippedMinSpend, checked };

  const minSpend    = parseFloat(rule.min_spend_threshold) || DEFAULT_MIN_SPEND;
  const isKillSwitch = rule.action_type === 'kill_switch';

  // PASS 1: Classify every entity — pure CPU, no I/O
  const toPause  = [];
  const toResume = [];

  for (const [entityId, entity] of Object.entries(liveData)) {
    if (rule.target_external_ids?.length && !rule.target_external_ids.includes(entityId)) continue;

    checked++;
    const isPausedByUs = !!pausedMap[entityId];

    if (entity.spend < minSpend && !isPausedByUs) {
      skippedMinSpend++;
      continue;
    }

    // Evaluate each condition against its OWN period's data
    const allConditionsMet = conditions.every(cond => {
      const condPeriod = cond.period || 'today';
      const periodEntity = periodDataMaps?.[condPeriod]?.[entityId];
      // Fall back to primary period entity if period data not available
      const target = periodEntity || entity;
      const value = getMetricValue(target, cond.metric);
      return evaluateCondition(value, cond.operator, parseFloat(cond.value));
    });

    if (allConditionsMet && !isPausedByUs) {
      breachingAds.push({ id: entityId, name: entity.entityName, cpr: entity.cpr, spend: entity.spend, results: entity.results, status: entity.status });
      if (entity.status !== 'ACTIVE') { skippedNotActive++; continue; }
      toPause.push({ entityId, entity });

    } else if (!allConditionsMet && isPausedByUs && !isKillSwitch) {
      const pauseRecord = pausedMap[entityId];
      if (pauseRecord.rule_id !== rule.id) continue;

      // Cooldown: don't resume until RESUME_COOLDOWN_MINUTES after pause
      const pausedAt = new Date(pauseRecord.paused_at).getTime();
      const cooldownMs = (rule.resume_cooldown_minutes || RESUME_COOLDOWN_MINUTES) * 60 * 1000;
      if (Date.now() - pausedAt < cooldownMs) continue;

      toResume.push({ entityId, entity });
    }
  }

  // PASS 2: Batch PAUSE via Meta Batch API
  if (toPause.length > 0) {
    const { succeeded: pauseOk, failed: pauseFail } = await metaBatchAction(toPause, 'PAUSED');

    if (pauseOk.length > 0) {
      await bulkSavePauses(rule, pauseOk, isKillSwitch);
      paused = pauseOk.length;

      await query(
        `UPDATE automation_rules
         SET trigger_count = $1, last_triggered_at = now()
         WHERE id = $2`,
        [(rule.trigger_count || 0) + paused, rule.id]
      );

      console.log(`[LiveMonitor] ⏸️  PAUSED ${paused} ${rule.scope}s via Batch API`);
    }

    for (const { entityId, entity, error } of pauseFail) {
      failedPauses.push({ id: entityId, name: entity.entityName, error });
      try {
        await query(
          `INSERT INTO automation_logs
             (rule_id, rule_name, entity_type, entity_id, entity_external_id, entity_name,
              action_type, action_params, condition_snapshot, status, error_message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [rule.id, rule.name, rule.scope, null, entityId, entity.entityName,
           'pause_ad', '{}', JSON.stringify(buildSnapshot(entity)), 'failed', error]
        );
      } catch {}

      const isDeleted = error && (
        error.includes('does not exist') ||
        error.includes('cannot be loaded due to missing permissions') ||
        error.includes('Object with ID')
      );
      if (isDeleted) {
        try {
          await query(
            `DELETE FROM automation_paused_ads WHERE ad_external_id = $1`,
            [entityId]
          );
          console.log(`[LiveMonitor] Removed deleted/inaccessible ad from tracking: ${entityId}`);
        } catch {}
      }
    }
  }

  // PASS 3: Batch RESUME via Meta Batch API
  if (toResume.length > 0) {
    const { succeeded: resumeOk } = await metaBatchAction(toResume, 'ACTIVE');

    if (resumeOk.length > 0) {
      await bulkSaveResumes(rule, resumeOk);
      resumed = resumeOk.length;
      console.log(`[LiveMonitor] ▶️  RESUMED ${resumed} ${rule.scope}s via Batch API`);
    }
  }

  return { paused, resumed, skippedMinSpend, checked, skippedNotActive, _breaching: breachingAds, _failedPauses: failedPauses };
}


// =============================================================
// META BATCH API — Up to 50 ops in 1 HTTP call
// =============================================================

async function metaBatchAction(entities, targetStatus) {
  const byToken = new Map();
  for (const { entityId, entity } of entities) {
    if (!byToken.has(entity.accessToken)) byToken.set(entity.accessToken, []);
    byToken.get(entity.accessToken).push({ entityId, entity });
  }

  const succeeded = [];
  const failed    = [];

  for (const [token, group] of byToken) {
    for (let i = 0; i < group.length; i += META_BATCH_SIZE) {
      const chunk = group.slice(i, i + META_BATCH_SIZE);

      try {
        const batchPayload = chunk.map(({ entityId }) => ({
          method: 'POST',
          relative_url: `v22.0/${entityId}`,
          body: `status=${targetStatus}`,
        }));

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
// BULK POSTGRESQL OPERATIONS — 3 DB calls per action type, not N×4
// Uses ANY($1::text[]) for bulk WHERE clauses
// =============================================================

async function bulkSavePauses(rule, entities, isKillSwitch) {
  const now = new Date().toISOString();
  const ids = entities.map(e => e.entityId);

  // 1. Remove stale rows for these entities
  await query(
    `DELETE FROM automation_paused_ads WHERE ad_external_id = ANY($1::text[])`,
    [ids]
  );

  // 2. Bulk insert paused tracking (include accountId in snapshot for targeted resume)
  const pauseValues = entities.map(({ entityId, entity }) => ({
    ad_external_id: entityId,
    ad_name: entity.entityName,
    rule_id: rule.id,
    rule_name: rule.name,
    reason: isKillSwitch ? 'kill_switch' : 'threshold',
    metric_snapshot: JSON.stringify({ ...buildSnapshot(entity), accountId: entity.accountId }),
    paused_at: now,
    is_paused: true,
  }));

  // Build parameterized bulk INSERT
  const pausePlaceholders = pauseValues.map((_, i) => {
    const base = i * 8;
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8})`;
  }).join(',');
  const pauseParams = pauseValues.flatMap(v => [
    v.ad_external_id, v.ad_name, v.rule_id, v.rule_name,
    v.reason, v.metric_snapshot, v.paused_at, v.is_paused,
  ]);

  await query(
    `INSERT INTO automation_paused_ads
       (ad_external_id, ad_name, rule_id, rule_name, reason, metric_snapshot, paused_at, is_paused)
     VALUES ${pausePlaceholders}`,
    pauseParams
  );

  // 3. Bulk insert automation logs
  const logValues = entities.map(({ entityId, entity }) => buildLogRow(rule, entityId, entity, 'executed'));
  await bulkInsertLogs(logValues);

  // 4. Bulk insert notifications
  const notifValues = entities.map(({ entityId, entity }) => ({
    type: 'automation_fired',
    title: `⏸️ Auto-Paused: ${entity.entityName}`,
    message: buildNotificationMessage(rule, entity),
    severity: 'warning',
    metadata: JSON.stringify({ rule_id: rule.id, entity_id: entityId, action: 'paused' }),
  }));
  await bulkInsertNotifications(notifValues);
}

async function bulkSaveResumes(rule, entities) {
  const now = new Date().toISOString();
  const ids = entities.map(e => e.entityId);

  // 1. Mark as resumed in bulk
  await query(
    `UPDATE automation_paused_ads
     SET is_paused = false, resumed_at = $1
     WHERE ad_external_id = ANY($2::text[]) AND is_paused = true`,
    [now, ids]
  );

  // 2. Bulk insert logs
  const logValues = entities.map(({ entityId, entity }) => buildLogRow(rule, entityId, entity, 'executed', null, 'enable_ad'));
  await bulkInsertLogs(logValues);

  // 3. Bulk insert notifications
  const notifValues = entities.map(({ entityId, entity }) => ({
    type: 'automation_fired',
    title: `▶️ Auto-Resumed: ${entity.entityName}`,
    message: buildNotificationMessage(rule, entity),
    severity: 'info',
    metadata: JSON.stringify({ rule_id: rule.id, entity_id: entityId, action: 'resumed' }),
  }));
  await bulkInsertNotifications(notifValues);
}

async function bulkInsertLogs(logValues) {
  if (!logValues.length) return;
  const placeholders = logValues.map((_, i) => {
    const base = i * 9;
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9})`;
  }).join(',');
  const params = logValues.flatMap(v => [
    v.rule_id, v.rule_name, v.entity_type, v.entity_id,
    v.entity_external_id, v.entity_name, v.action_type,
    v.condition_snapshot, v.status,
  ]);
  await query(
    `INSERT INTO automation_logs
       (rule_id, rule_name, entity_type, entity_id, entity_external_id,
        entity_name, action_type, condition_snapshot, status)
     VALUES ${placeholders}`,
    params
  );
}

async function bulkInsertNotifications(notifValues) {
  if (!notifValues.length) return;
  const placeholders = notifValues.map((_, i) => {
    const base = i * 5;
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5})`;
  }).join(',');
  const params = notifValues.flatMap(v => [
    v.type, v.title, v.message, v.severity, v.metadata,
  ]);
  await query(
    `INSERT INTO notifications (type, title, message, severity, metadata)
     VALUES ${placeholders}`,
    params
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
    case '>':            return actual >  expected;
    case '<':            return actual <  expected;
    case '>=':           return actual >= expected;
    case '<=':           return actual <= expected;
    case '=': case '==': return actual === expected;
    case '!=':           return actual !== expected;
    default:             return false;
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
// (unchanged — these call Meta API, not the database)
// =============================================================

function mergeInsightsAndStatuses(insights, statuses, dataMap, account) {
  for (const item of insights) {
    const statusInfo = statuses[item.entityId];
    dataMap[item.entityId] = {
      ...item,
      status:      statusInfo?.status || 'UNKNOWN',
      accountId:   statusInfo?.accountId || account.meta_account_id,
      accessToken: statusInfo?.accessToken || account.access_token,
    };
  }

  for (const [entityId, info] of Object.entries(statuses)) {
    if (!dataMap[entityId]) {
      dataMap[entityId] = {
        entityId, entityName: info.name || entityId,
        spend: 0, results: 0, cpr: 0, impressions: 0, clicks: 0,
        cpc: 0, ctr: 0, cpm: 0,
        status:      info.status || 'UNKNOWN',
        accountId:   info.accountId || account.meta_account_id,
        accessToken: info.accessToken || account.access_token,
      };
    }
  }
}

function getDateRangeForPeriod(period) {
  // With TZ=Asia/Kolkata set in ecosystem.config.js, toLocaleDateString
  // returns IST dates without manual offset math.
  const now = new Date();
  const todayStr = formatLocalDate(now);

  if (period === 'today') {
    return { since: todayStr, until: todayStr };
  }

  if (period === 'yesterday') {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return { since: formatLocalDate(yesterday), until: formatLocalDate(yesterday) };
  }

  let days = 1;
  if (period === 'last_3_days') days = 3;
  else if (period === 'last_7_days') days = 7;
  else if (period === 'last_14_days') days = 14;
  else if (period === 'last_30_days') days = 30;

  const sinceDate = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return { since: formatLocalDate(sinceDate), until: todayStr };
}

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function fetchAllLiveInsights(accountId, accessToken, level = 'ad', period = 'today') {
  const { since, until } = getDateRangeForPeriod(period);

  const idField   = level === 'ad' ? 'ad_id'    : 'adset_id';
  const nameField = level === 'ad' ? 'ad_name'  : 'adset_name';

  const fields    = `${idField},${nameField},spend,impressions,clicks,actions,objective`;
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));

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
    const objective   = row.objective || '';
    const results     = extractConversions(row.actions, objective);

    const cpc = clicks      > 0 ? +(spend / clicks).toFixed(4)              : 0;
    const ctr = impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0;
    const cpm = impressions > 0 ? +((spend / impressions) * 1000).toFixed(4) : 0;
    const cpr = results > 0 ? +(spend / results).toFixed(2) : (spend > 0 ? 999999 : 0);

    return { entityId: row[idField], entityName: row[nameField], spend, impressions, clicks, results, cpc, ctr, cpm, cpr, objective };
  });
}

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
      return map;
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
    condition_snapshot: JSON.stringify(buildSnapshot(entity)),
    status,
  };
}

function buildNotificationMessage(rule, entity) {
  const parts = [`Rule "${rule.name}"`];
  if (entity.cpr > 0 && entity.cpr < 999999) parts.push(`CPR: $${entity.cpr.toFixed(2)}`);
  if (entity.results === 0 && entity.spend > 0) parts.push('Results: 0 (no conversions)');
  parts.push(`Spend: $${entity.spend.toFixed(2)}`);
  return parts.join(' — ');
}
