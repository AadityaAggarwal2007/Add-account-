import { NextResponse } from 'next/server';
import { queryRows, queryOne, query } from '@/lib/db';
import { fetchCampaigns, fetchInsights } from '@/lib/meta-api';
import { subDays, format } from 'date-fns';

// POST /api/sync — Triggers a full data sync for all active accounts
// Now syncs campaign, ad-set, AND ad-level metrics so the DB-based
// rule evaluator can work at every scope.
export const maxDuration = 120;

export async function POST(request) {
  const authHeader = request.headers.get('x-cron-secret');
  const manualTrigger = request.headers.get('x-manual-trigger');
  const syncDays = parseInt(request.headers.get('x-sync-days') || '30') || 30;

  if (!manualTrigger && authHeader !== process.env.CRON_SECRET_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const accounts = await queryRows(
      `SELECT * FROM meta_accounts WHERE is_active = true`
    );
    if (!accounts.length) return NextResponse.json({ message: 'No active accounts to sync' });

    const results = await Promise.all(accounts.map(account => syncAccount(account, syncDays)));
    return NextResponse.json({ results });
  } catch (err) {
    console.error('Sync error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

async function syncAccount(account, syncDays = 30) {
  const syncStart = Date.now();

  const syncRecord = await queryOne(
    `INSERT INTO sync_status (meta_account_id, sync_type, status, started_at)
     VALUES ($1, 'full', 'running', now()) RETURNING id`,
    [account.id]
  );

  try {
    let recordCount = 0;

    const dateTo = format(new Date(), 'yyyy-MM-dd');
    const dateFrom = format(subDays(new Date(), syncDays), 'yyyy-MM-dd');

    // 1. Fetch campaigns + all insight levels in PARALLEL
    const [campaigns, campaignInsights, adsetInsights, adInsights] = await Promise.all([
      fetchCampaigns(account.meta_account_id, account.access_token),
      fetchInsights(account.meta_account_id, account.access_token, dateFrom, dateTo, 'campaign').catch(e => {
        console.warn(`[sync] Campaign insights failed for ${account.name}:`, e.message);
        return [];
      }),
      fetchInsights(account.meta_account_id, account.access_token, dateFrom, dateTo, 'adset').catch(e => {
        console.warn(`[sync] Ad set insights failed for ${account.name}:`, e.message);
        return [];
      }),
      fetchInsights(account.meta_account_id, account.access_token, dateFrom, dateTo, 'ad').catch(e => {
        console.warn(`[sync] Ad insights failed for ${account.name}:`, e.message);
        return [];
      }),
    ]);

    // 2. Bulk upsert campaigns via INSERT ... ON CONFLICT
    if (campaigns.length > 0) {
      for (let i = 0; i < campaigns.length; i += 50) {
        const chunk = campaigns.slice(i, i + 50);
        const placeholders = chunk.map((_, j) => {
          const base = j * 10;
          return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10})`;
        }).join(',');

        const params = chunk.flatMap(c => [
          account.id, c.externalId, c.name, c.status, c.objective,
          c.dailyBudget || null, c.lifetimeBudget || null,
          c.buyingType || null, c.startDate || null, c.endDate || null,
        ]);

        await query(
          `INSERT INTO campaigns
             (meta_account_id, external_id, name, status, objective,
              daily_budget, lifetime_budget, buying_type, start_date, end_date)
           VALUES ${placeholders}
           ON CONFLICT (external_id) DO UPDATE SET
             name = EXCLUDED.name, status = EXCLUDED.status, objective = EXCLUDED.objective,
             daily_budget = EXCLUDED.daily_budget, lifetime_budget = EXCLUDED.lifetime_budget,
             buying_type = EXCLUDED.buying_type, start_date = EXCLUDED.start_date,
             end_date = EXCLUDED.end_date, updated_at = now()`,
          params
        );
      }
      recordCount += campaigns.length;
    }

    // 3. Build campaign ID lookup (one query)
    const externalIds = campaigns.map(c => c.externalId);
    const dbCampaigns = externalIds.length > 0
      ? await queryRows(
          `SELECT id, external_id FROM campaigns WHERE external_id = ANY($1::text[])`,
          [externalIds]
        )
      : [];

    const campaignMap = {};
    for (const dc of dbCampaigns) campaignMap[dc.external_id] = dc.id;

    // 4. Sync CAMPAIGN-level metrics
    recordCount += await syncMetricsLevel({
      accountName: account.name,
      insights: campaignInsights,
      entityType: 'campaign',
      dateFrom,
      dateTo,
      mapExternalToDbId: (row) => campaignMap[row.campaignId],
      idColumn: 'campaign_id',
      deleteFilter: Object.values(campaignMap),
    });

    // 5. Sync AD-SET-level metrics (use campaign external ID → DB ID mapping)
    recordCount += await syncMetricsLevel({
      accountName: account.name,
      insights: adsetInsights,
      entityType: 'ad_set',
      dateFrom,
      dateTo,
      mapExternalToDbId: (row) => campaignMap[row.campaignId],
      idColumn: 'campaign_id',
      extraColumns: { ad_set_id: (row) => row.adSetId },
      deleteFilter: Object.values(campaignMap),
    });

    // 6. Sync AD-level metrics
    recordCount += await syncMetricsLevel({
      accountName: account.name,
      insights: adInsights,
      entityType: 'ad',
      dateFrom,
      dateTo,
      mapExternalToDbId: (row) => campaignMap[row.campaignId],
      idColumn: 'campaign_id',
      extraColumns: {
        ad_set_id: (row) => row.adSetId,
        ad_id: (row) => row.adId,
      },
      deleteFilter: Object.values(campaignMap),
    });

    // 7. Update sync status + account
    const duration = Date.now() - syncStart;
    await Promise.all([
      query(
        `UPDATE sync_status SET status = 'success', records_processed = $1, completed_at = now(), duration_ms = $2 WHERE id = $3`,
        [recordCount, duration, syncRecord.id]
      ),
      query(
        `UPDATE meta_accounts SET last_synced_at = now() WHERE id = $1`,
        [account.id]
      ),
    ]);

    console.log(`[sync] ${account.name}: done — ${recordCount} records in ${duration}ms`);
    return { account: account.name, status: 'success', records: recordCount, duration };
  } catch (err) {
    console.error(`Sync failed for ${account.name}:`, err);
    await query(
      `UPDATE sync_status SET status = 'failed', error_message = $1, completed_at = now(), duration_ms = $2 WHERE id = $3`,
      [err.message, Date.now() - syncStart, syncRecord?.id]
    );
    await query(
      `INSERT INTO notifications (type, title, message, severity, metadata) VALUES ($1,$2,$3,$4,$5)`,
      ['sync_failed', `Sync failed for ${account.name}`, err.message, 'critical', JSON.stringify({ accountId: account.id })]
    );
    return { account: account.name, status: 'failed', error: err.message };
  }
}

async function syncMetricsLevel({ accountName, insights, entityType, dateFrom, dateTo, mapExternalToDbId, idColumn, extraColumns = {}, deleteFilter }) {
  if (!insights.length) {
    console.log(`[sync] ${accountName}: 0 ${entityType} insights`);
    return 0;
  }

  const metricRows = insights
    .filter(row => mapExternalToDbId(row))
    .map(row => {
      const base = {
        entity_type: entityType,
        campaign_id: mapExternalToDbId(row),
        date: row.date,
        impressions: row.impressions,
        clicks: row.clicks,
        spend: row.spend,
        conversions: row.conversions,
        conversion_value: row.conversionValue,
        reach: row.reach,
        frequency: row.frequency,
      };
      for (const [col, fn] of Object.entries(extraColumns)) {
        base[col] = fn(row);
      }
      return base;
    });

  console.log(`[sync] ${accountName}: ${insights.length} ${entityType} insight rows, ${metricRows.length} matched`);

  // Delete old metrics for this entity type and date range
  if (deleteFilter.length > 0) {
    await query(
      `DELETE FROM metrics
       WHERE entity_type = $1
         AND ${idColumn} = ANY($2::uuid[])
         AND date >= $3 AND date <= $4`,
      [entityType, deleteFilter, dateFrom, dateTo]
    );
  }

  // Bulk insert in chunks of 50
  const extraCols = Object.keys(extraColumns);
  const colCount = 10 + extraCols.length;

  for (let i = 0; i < metricRows.length; i += 50) {
    const chunk = metricRows.slice(i, i + 50);
    const placeholders = chunk.map((_, j) => {
      const base = j * colCount;
      const indices = Array.from({ length: colCount }, (_, k) => `$${base + k + 1}`);
      return `(${indices.join(',')})`;
    }).join(',');

    const params = chunk.flatMap(r => {
      const base = [
        r.entity_type, r.campaign_id, r.date, r.impressions, r.clicks,
        r.spend, r.conversions, r.conversion_value, r.reach, r.frequency,
      ];
      for (const col of extraCols) {
        base.push(r[col] || null);
      }
      return base;
    });

    const extraColNames = extraCols.length ? ', ' + extraCols.join(', ') : '';

    try {
      await query(
        `INSERT INTO metrics
           (entity_type, campaign_id, date, impressions, clicks,
            spend, conversions, conversion_value, reach, frequency${extraColNames})
         VALUES ${placeholders}
         ON CONFLICT DO NOTHING`,
        params
      );
    } catch (insertErr) {
      console.error(`[sync] ${entityType} metrics insert error for ${accountName}:`, insertErr.message);
    }
  }

  return metricRows.length;
}
