// =============================================================
// RULE EVALUATOR ENGINE — Server Only
// Evaluates automation rules against current metrics and executes actions.
// Migrated from Supabase JS → direct PostgreSQL (pg).
// =============================================================

import { query, queryOne, queryRows } from '@/lib/db';
import { pauseCampaign, enableCampaign, updateBudget } from '@/lib/meta-api';
import { subDays, format } from 'date-fns';

/**
 * Main entry: evaluate all active rules
 */
export async function evaluateAllRules() {
  // Check global kill switch
  const setting = await queryOne(
    `SELECT value FROM system_settings WHERE key = 'automation_enabled'`
  );

  if (!setting?.value?.enabled) {
    console.log('[Evaluator] Automation is globally disabled.');
    return { skipped: true, reason: 'automation_disabled' };
  }

  // Load active rules
  const rules = await queryRows(
    `SELECT * FROM automation_rules WHERE is_active = true ORDER BY created_at ASC`
  );

  if (!rules.length) return { evaluated: 0, triggered: 0 };

  const results = [];

  for (const rule of rules) {
    try {
      const result = await evaluateRule(rule);
      results.push(result);
    } catch (err) {
      console.error(`[Evaluator] Rule "${rule.name}" error:`, err.message);
      results.push({ rule: rule.name, error: err.message });
    }
  }

  return {
    evaluated: rules.length,
    triggered: results.filter(r => r.triggered).length,
    results,
  };
}

/**
 * Evaluate a single rule against all matching entities
 */
async function evaluateRule(rule) {
  const entities = await getTargetEntities(rule);
  const triggered = [];

  for (const entity of entities) {
    const canTrigger = await checkCanTrigger(rule, entity.id);
    if (!canTrigger.allowed) {
      await logAction(rule, entity, rule.action_type, null, {}, `skipped_${canTrigger.reason}`);
      continue;
    }

    const metrics = await getEntityMetrics(rule, entity);

    const allConditionsMet = rule.conditions.every(cond =>
      evaluateCondition(cond, metrics)
    );

    if (!allConditionsMet) continue;

    const conditionSnapshot = buildConditionSnapshot(rule.conditions, metrics);

    if (rule.dry_run) {
      await logAction(rule, entity, rule.action_type, rule.action_params, conditionSnapshot, 'dry_run');
      await createNotification(rule, entity, '🧪 Dry Run');
      triggered.push({ entity: entity.name, status: 'dry_run' });
      continue;
    }

    if (rule.requires_approval) {
      await logAction(rule, entity, rule.action_type, rule.action_params, conditionSnapshot, 'pending_approval');
      await createNotification(rule, entity, '⏳ Pending Approval');
      triggered.push({ entity: entity.name, status: 'pending_approval' });
      continue;
    }

    try {
      const previousValue = await capturePreviousValue(entity, rule.action_type);
      const apiResponse = await executeAction(rule, entity);

      await logAction(rule, entity, rule.action_type, rule.action_params, conditionSnapshot, 'executed', null, apiResponse, previousValue);
      await createNotification(rule, entity, '✅ Executed');

      // Update rule metadata
      await query(
        `UPDATE automation_rules
         SET last_triggered_at = now(),
             trigger_count = $1,
             updated_at = now()
         WHERE id = $2`,
        [(rule.trigger_count || 0) + 1, rule.id]
      );

      triggered.push({ entity: entity.name, status: 'executed' });
    } catch (err) {
      await logAction(rule, entity, rule.action_type, rule.action_params, conditionSnapshot, 'failed', err.message);
      await createNotification(rule, entity, '❌ Failed', 'critical');
      triggered.push({ entity: entity.name, status: 'failed', error: err.message });
    }
  }

  return { rule: rule.name, entities: entities.length, triggered };
}

/**
 * Get entities that this rule targets
 */
async function getTargetEntities(rule) {
  const table = rule.scope === 'campaign' ? 'campaigns'
    : rule.scope === 'ad_set' ? 'ad_sets' : 'ads';

  const conditions = ['1=1'];
  const params = [];

  if (rule.target_ids?.length) {
    params.push(rule.target_ids);
    conditions.push(`id = ANY($${params.length}::uuid[])`);
  }

  if (rule.target_account_ids?.length && rule.scope === 'campaign') {
    params.push(rule.target_account_ids);
    conditions.push(`meta_account_id = ANY($${params.length}::uuid[])`);
  }

  const rows = await queryRows(
    `SELECT id, external_id, name, status, daily_budget, meta_account_id
     FROM ${table}
     WHERE ${conditions.join(' AND ')}`,
    params
  );
  return rows;
}

/**
 * Check if a rule can trigger for a specific entity (cooldown + daily limit)
 */
async function checkCanTrigger(rule, entityId) {
  // Check cooldown
  const lastLog = await queryOne(
    `SELECT created_at FROM automation_logs
     WHERE rule_id = $1
       AND entity_id = $2
       AND status = ANY($3::text[])
     ORDER BY created_at DESC
     LIMIT 1`,
    [rule.id, entityId, ['executed', 'dry_run', 'pending_approval']]
  );

  if (lastLog) {
    const minutesSince = (Date.now() - new Date(lastLog.created_at).getTime()) / 60000;
    if (minutesSince < rule.cooldown_minutes) {
      return { allowed: false, reason: 'cooldown' };
    }
  }

  // Check daily trigger limit
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const countRow = await queryOne(
    `SELECT COUNT(*) as count FROM automation_logs
     WHERE rule_id = $1
       AND entity_id = $2
       AND status = 'executed'
       AND created_at >= $3`,
    [rule.id, entityId, todayStart.toISOString()]
  );

  if (parseInt(countRow?.count || '0') >= rule.max_triggers_per_day) {
    return { allowed: false, reason: 'max_triggers' };
  }

  return { allowed: true };
}

/**
 * Get aggregated metrics for an entity over the rule's condition periods
 */
async function getEntityMetrics(rule, entity) {
  const periods = [...new Set(rule.conditions.map(c => c.period))];
  const metrics = {};

  for (const period of periods) {
    const { dateFrom, dateTo } = getPeriodDates(period);

    const entityColumn = rule.scope === 'campaign' ? 'campaign_id'
      : rule.scope === 'ad_set' ? 'ad_set_id' : 'ad_id';

    const rows = await queryRows(
      `SELECT spend, impressions, clicks, conversions, conversion_value, reach
       FROM metrics
       WHERE entity_type = $1
         AND ${entityColumn} = $2
         AND date >= $3
         AND date <= $4`,
      [rule.scope, entity.id, dateFrom, dateTo]
    );

    const agg = (rows || []).reduce((acc, row) => ({
      spend: acc.spend + parseFloat(row.spend || 0),
      impressions: acc.impressions + parseInt(row.impressions || 0),
      clicks: acc.clicks + parseInt(row.clicks || 0),
      conversions: acc.conversions + parseFloat(row.conversions || 0),
      conversion_value: acc.conversion_value + parseFloat(row.conversion_value || 0),
      reach: acc.reach + parseInt(row.reach || 0),
    }), { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversion_value: 0, reach: 0 });

    // Computed metrics
    agg.cpc = agg.clicks > 0 ? agg.spend / agg.clicks : 0;
    agg.ctr = agg.impressions > 0 ? (agg.clicks / agg.impressions) * 100 : 0;
    agg.roas = agg.spend > 0 ? agg.conversion_value / agg.spend : 0;
    agg.cpr = agg.conversions > 0 ? agg.spend / agg.conversions : (agg.spend > 0 ? 999999 : 0);
    agg.cpm = agg.impressions > 0 ? (agg.spend / agg.impressions) * 1000 : 0;

    metrics[period] = agg;
  }

  return metrics;
}

/**
 * Evaluate a single condition against metrics
 */
function evaluateCondition(condition, metricsMap) {
  const periodMetrics = metricsMap[condition.period];
  if (!periodMetrics) return false;

  const actual = periodMetrics[condition.metric];
  if (actual == null) return false;

  const expected = parseFloat(condition.value);

  switch (condition.operator) {
    case '>': return actual > expected;
    case '<': return actual < expected;
    case '>=': return actual >= expected;
    case '<=': return actual <= expected;
    case '=': return actual === expected;
    case '!=': return actual !== expected;
    default: return false;
  }
}

/**
 * Execute the automation action via Meta API
 */
async function executeAction(rule, entity) {
  let accountId;
  if (rule.scope === 'campaign') {
    accountId = entity.meta_account_id;
  } else {
    const campaign = await queryOne(
      `SELECT meta_account_id FROM campaigns WHERE id = $1`,
      [entity.campaign_id || entity.id]
    );
    accountId = campaign?.meta_account_id;
  }

  const account = await queryOne(
    `SELECT access_token FROM meta_accounts WHERE id = $1`,
    [accountId]
  );

  if (!account?.access_token) throw new Error('No access token found for account');

  const token = account.access_token;
  const externalId = entity.external_id;

  switch (rule.action_type) {
    case 'pause_campaign':
      return await pauseCampaign(externalId, token);

    case 'enable_campaign':
      return await enableCampaign(externalId, token);

    case 'increase_budget': {
      const currentBudget = parseFloat(entity.daily_budget || 0);
      const pct = rule.action_params?.percentage || 20;
      const maxBudget = rule.action_params?.max_budget || Infinity;
      const newBudget = Math.min(currentBudget * (1 + pct / 100), maxBudget);
      return await updateBudget(externalId, newBudget, token);
    }

    case 'decrease_budget': {
      const currentBudget2 = parseFloat(entity.daily_budget || 0);
      const pct2 = rule.action_params?.percentage || 20;
      const minBudget = rule.action_params?.min_budget || 1;
      const newBudget2 = Math.max(currentBudget2 * (1 - pct2 / 100), minBudget);
      return await updateBudget(externalId, newBudget2, token);
    }

    case 'set_budget': {
      const amount = rule.action_params?.amount;
      if (!amount) throw new Error('No budget amount specified');
      return await updateBudget(externalId, amount, token);
    }

    case 'send_alert':
      return { success: true, type: 'alert_only' };

    default:
      throw new Error(`Unknown action type: ${rule.action_type}`);
  }
}

/**
 * Capture previous value for undo support
 */
async function capturePreviousValue(entity, actionType) {
  if (['pause_campaign', 'enable_campaign'].includes(actionType)) {
    return { status: entity.status };
  }
  if (['increase_budget', 'decrease_budget', 'set_budget'].includes(actionType)) {
    return { daily_budget: entity.daily_budget, status: entity.status };
  }
  return null;
}

/**
 * Log an automation action
 */
async function logAction(rule, entity, actionType, actionParams, conditionSnapshot, status, errorMessage = null, apiResponse = null, previousValue = null) {
  await query(
    `INSERT INTO automation_logs
       (rule_id, rule_name, entity_type, entity_id, entity_external_id, entity_name,
        action_type, action_params, condition_snapshot, status, error_message, api_response, previous_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      rule.id, rule.name, rule.scope,
      entity.id, entity.external_id, entity.name,
      actionType, actionParams ? JSON.stringify(actionParams) : null,
      JSON.stringify(conditionSnapshot || {}),
      status, errorMessage,
      apiResponse ? JSON.stringify(apiResponse) : null,
      previousValue ? JSON.stringify(previousValue) : null,
    ]
  );
}

/**
 * Create an in-app notification
 */
async function createNotification(rule, entity, statusEmoji, severity = 'info') {
  const actionLabels = {
    pause_campaign: 'Paused',
    enable_campaign: 'Enabled',
    increase_budget: 'Budget Increased',
    decrease_budget: 'Budget Decreased',
    set_budget: 'Budget Set',
    send_alert: 'Alert',
  };

  await query(
    `INSERT INTO notifications (type, title, message, severity, metadata)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      'automation_fired',
      `${statusEmoji} ${rule.name}`,
      `${actionLabels[rule.action_type] || rule.action_type} — "${entity.name}"`,
      severity,
      JSON.stringify({ rule_id: rule.id, entity_id: entity.id }),
    ]
  );
}

/**
 * Convert period string to date range
 */
function getPeriodDates(period) {
  const today = format(new Date(), 'yyyy-MM-dd');
  const yesterday = format(subDays(new Date(), 1), 'yyyy-MM-dd');

  switch (period) {
    case 'today': return { dateFrom: today, dateTo: today };
    case 'yesterday': return { dateFrom: yesterday, dateTo: yesterday };
    case 'last_3_days': return { dateFrom: format(subDays(new Date(), 3), 'yyyy-MM-dd'), dateTo: today };
    case 'last_7_days': return { dateFrom: format(subDays(new Date(), 7), 'yyyy-MM-dd'), dateTo: today };
    case 'last_14_days': return { dateFrom: format(subDays(new Date(), 14), 'yyyy-MM-dd'), dateTo: today };
    case 'last_30_days': return { dateFrom: format(subDays(new Date(), 30), 'yyyy-MM-dd'), dateTo: today };
    default: return { dateFrom: today, dateTo: today };
  }
}

function buildConditionSnapshot(conditions, metricsMap) {
  const snapshot = {};
  for (const c of conditions) {
    const periodMetrics = metricsMap[c.period];
    if (periodMetrics) {
      snapshot[`${c.metric}_${c.period}`] = periodMetrics[c.metric];
    }
  }
  snapshot.evaluated_at = new Date().toISOString();
  return snapshot;
}
