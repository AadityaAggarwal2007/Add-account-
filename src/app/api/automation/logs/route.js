import { NextResponse } from 'next/server';
import { queryRows, queryOne, query } from '@/lib/db';
import { pauseCampaign, enableCampaign, pauseAd, enableAd, pauseAdSet, enableAdSet } from '@/lib/meta-api';

export const dynamic = 'force-dynamic';

// GET /api/automation/logs — Fetch automation execution history
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const ruleId = searchParams.get('rule_id');
  const limit = parseInt(searchParams.get('limit') || '50');

  try {
    const logs = await queryRows(
      `SELECT * FROM automation_logs
       ${ruleId ? 'WHERE rule_id = $1' : ''}
       ORDER BY created_at DESC
       LIMIT ${ruleId ? '$2' : '$1'}`,
      ruleId ? [ruleId, limit] : [limit]
    );
    return NextResponse.json({ logs });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/automation/logs — Undo (reverse) an automation action
export async function POST(request) {
  const { logId } = await request.json();
  if (!logId) return NextResponse.json({ error: 'Missing logId' }, { status: 400 });

  try {
    const log = await queryOne(
      `SELECT * FROM automation_logs WHERE id = $1`,
      [logId]
    );

    if (!log) return NextResponse.json({ error: 'Log not found' }, { status: 404 });
    if (log.is_reversed) return NextResponse.json({ error: 'Already reversed' }, { status: 400 });
    if (!log.previous_value) return NextResponse.json({ error: 'No previous value to restore' }, { status: 400 });

    // Get access token for this entity's account
    const accounts = await queryRows(
      `SELECT access_token FROM meta_accounts WHERE is_active = true`
    );
    if (!accounts.length) return NextResponse.json({ error: 'No active accounts' }, { status: 400 });

    const externalId = log.entity_external_id;
    const previousStatus = log.previous_value?.status;
    const entityType = log.entity_type;

    if (!externalId) return NextResponse.json({ error: 'No external ID to reverse' }, { status: 400 });

    let reversed = false;
    for (const account of accounts) {
      try {
        if (previousStatus === 'ACTIVE') {
          if (entityType === 'campaign') await enableCampaign(externalId, account.access_token);
          else if (entityType === 'ad_set') await enableAdSet(externalId, account.access_token);
          else await enableAd(externalId, account.access_token);
        } else {
          if (entityType === 'campaign') await pauseCampaign(externalId, account.access_token);
          else if (entityType === 'ad_set') await pauseAdSet(externalId, account.access_token);
          else await pauseAd(externalId, account.access_token);
        }
        reversed = true;
        break;
      } catch { continue; }
    }

    if (!reversed) return NextResponse.json({ error: 'Failed to reverse action on Meta' }, { status: 500 });

    await query(
      `UPDATE automation_logs SET is_reversed = true, reversed_at = now() WHERE id = $1`,
      [logId]
    );

    // Also clear from paused tracking if we're re-enabling
    if (previousStatus === 'ACTIVE') {
      await query(
        `UPDATE automation_paused_ads SET is_paused = false, resumed_at = now()
         WHERE ad_external_id = $1 AND is_paused = true`,
        [externalId]
      );
    }

    return NextResponse.json({ success: true, message: 'Action reversed via Meta API' });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
