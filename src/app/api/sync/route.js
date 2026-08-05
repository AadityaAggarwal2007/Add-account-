import { NextResponse } from 'next/server';
import { queryRows, queryOne, query } from '@/lib/db';
import { fetchCampaigns, fetchInsights } from '@/lib/meta-api';
import { subDays, format } from 'date-fns';

// POST /api/sync — Triggers a full data sync for all active accounts
export const maxDuration = 60;

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

  // Insert sync status record
  const syncRecord = await queryOne(
    `INSERT INTO sync_status (meta_account_id, sync_type, status, started_at)
     VALUES ($1, 'full', 'running', now()) RETURNING id`,
    [account.id]
  );

  try {
    let recordCount = 0;

    const dateTo = format(new Date(), 'yyyy-MM-dd');
    const dateFrom = format(subDays(new Date(), syncDays), 'yyyy-MM-dd');

    // 1. Fetch campaigns + insights in PARALLEL
    const [campaigns, insights] = await Promise.all([
      fetchCampaigns(account.meta_account_id, account.access_token),
      fetchInsights(account.meta_account_id, account.access_token, dateFrom, dateTo, 'campaign').catch(e => {
        console.warn(`Insights failed for ${account.name}:`, e.message);
        return [];
      }),
    ]);

    // 2. Bulk upsert campaigns via INSERT ... ON CONFLICT
    if (campaigns.length > 0) {
      // Process in chunks of 50 to avoid huge parameter lists
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
              daily_budget, lifetime_budget, buying_type, start_date, end_date, updated_at)
           VALUES ${placeholders.replace(/\)\,/g, ',updated_at=now()),').replace(/\)$/, ',updated_at=now())')}
           ON CONFLICT (external_id) DO UPDATE SET
             name = EXCLUDED.name, status = EXCLUDED.status, objective = EXCLUDED.objective,
             daily_budget = EXCLUDED.daily_budget, lifetime_budget = EXCLUDED.lifetime_budget,
             updated_at = now()`,
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

    // 4. Delete old metrics + insert fresh ones
    if (insights.length > 0) {
      const metricRows = insights.filter(row => campaignMap[row.campaignId]).map(row => ({
        entity_type: 'campaign',
        campaign_id: campaignMap[row.campaignId],
        date: row.date,
        impressions: row.impressions,
        clicks: row.clicks,
        spend: row.spend,
        conversions: row.conversions,
        conversion_value: row.conversionValue,
        reach: row.reach,
        frequency: row.frequency,
        link_clicks: row.linkClicks,
        raw_data: row.rawData,
      }));

      console.log(`[sync] ${account.name}: ${insights.length} insight rows, ${metricRows.length} matched campaigns`);

      const campaignDbIds = Object.values(campaignMap);
      if (campaignDbIds.length > 0) {
        await query(
          `DELETE FROM metrics
           WHERE entity_type = 'campaign'
             AND campaign_id = ANY($1::uuid[])
             AND date >= $2 AND date <= $3`,
          [campaignDbIds, dateFrom, dateTo]
        );
      }

      // Bulk insert in chunks of 50
      for (let i = 0; i < metricRows.length; i += 50) {
        const chunk = metricRows.slice(i, i + 50);
        const placeholders = chunk.map((_, j) => {
          const base = j * 10;
          return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10})`;
        }).join(',');
        const params = chunk.flatMap(r => [
          r.entity_type, r.campaign_id, r.date, r.impressions, r.clicks,
          r.spend, r.conversions, r.conversion_value, r.reach, r.frequency,
        ]);
        try {
          await query(
            `INSERT INTO metrics
               (entity_type, campaign_id, date, impressions, clicks,
                spend, conversions, conversion_value, reach, frequency)
             VALUES ${placeholders}
             ON CONFLICT DO NOTHING`,
            params
          );
        } catch (insertErr) {
          console.error(`[sync] Metrics insert error for ${account.name}:`, insertErr.message);
        }
      }
      recordCount += metricRows.length;
    } else {
      console.log(`[sync] ${account.name}: 0 insights returned`);
    }

    // 5. Update sync status + account
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
