import { NextResponse } from 'next/server';
import { queryRows, queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

// GET /api/debug — Shows raw database state for troubleshooting
export async function GET() {
  try {
    const [accounts, campaigns, campaignCount, metrics, metricCount, syncStatus, notifications] =
      await Promise.all([
        queryRows(
          `SELECT id, meta_account_id, name, is_active, last_synced_at
           FROM meta_accounts LIMIT 20`
        ),
        queryRows(
          `SELECT id, external_id, name, status, meta_account_id
           FROM campaigns LIMIT 5`
        ),
        queryOne(`SELECT COUNT(*) as count FROM campaigns`),
        queryRows(
          `SELECT id, campaign_id, date, spend, clicks, impressions, conversions, entity_type
           FROM metrics ORDER BY date DESC LIMIT 10`
        ),
        queryOne(`SELECT COUNT(*) as count FROM metrics`),
        queryRows(
          `SELECT * FROM sync_status ORDER BY started_at DESC LIMIT 5`
        ),
        queryRows(
          `SELECT * FROM notifications ORDER BY created_at DESC LIMIT 5`
        ),
      ]);

    return NextResponse.json({
      accounts,
      campaigns: { count: parseInt(campaignCount?.count || '0'), sample: campaigns },
      metrics: { count: parseInt(metricCount?.count || '0'), sample: metrics },
      syncStatus,
      notifications,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
