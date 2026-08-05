import { NextResponse } from 'next/server';
import { queryRows, queryOne, query } from '@/lib/db';

const META_GRAPH_URL = 'https://graph.facebook.com/v22.0';

// GET /api/automation/paused — List all currently auto-paused ads
export async function GET() {
  try {
    const paused = await queryRows(
      `SELECT * FROM automation_paused_ads WHERE is_paused = true ORDER BY paused_at DESC`
    );
    return NextResponse.json({ paused });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/automation/paused — Manually resume a paused ad
export async function POST(request) {
  const { adExternalId } = await request.json();
  if (!adExternalId) return NextResponse.json({ error: 'adExternalId required' }, { status: 400 });

  try {
    const pausedRecord = await queryOne(
      `SELECT * FROM automation_paused_ads WHERE ad_external_id = $1 AND is_paused = true`,
      [adExternalId]
    );

    if (!pausedRecord) {
      return NextResponse.json({ error: 'Paused ad not found' }, { status: 404 });
    }

    const accounts = await queryRows(
      `SELECT access_token FROM meta_accounts WHERE is_active = true`
    );

    if (!accounts.length) return NextResponse.json({ error: 'No active account' }, { status: 400 });

    let resumed = false;
    for (const account of accounts) {
      try {
        const res = await fetch(`${META_GRAPH_URL}/${adExternalId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'ACTIVE', access_token: account.access_token }),
        });

        if (res.ok) {
          resumed = true;

          await query(
            `UPDATE automation_paused_ads SET is_paused = false, resumed_at = now()
             WHERE ad_external_id = $1 AND is_paused = true`,
            [adExternalId]
          );

          await query(
            `INSERT INTO automation_logs
               (rule_id, rule_name, entity_type, entity_external_id, entity_name,
                action_type, action_params, condition_snapshot, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              pausedRecord.rule_id,
              pausedRecord.rule_name || 'Manual Resume',
              'ad',
              adExternalId,
              pausedRecord.ad_name,
              'enable_ad', '{}',
              JSON.stringify(pausedRecord.metric_snapshot || {}),
              'executed',
            ]
          );

          await query(
            `INSERT INTO notifications (type, title, message, severity, metadata)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              'automation_fired',
              `▶️ Manual Resume: ${pausedRecord.ad_name}`,
              `Manually resumed ad that was auto-paused by rule "${pausedRecord.rule_name}"`,
              'info',
              JSON.stringify({ ad_external_id: adExternalId, action: 'manual_resume' }),
            ]
          );

          break;
        }
      } catch { continue; }
    }

    if (!resumed) return NextResponse.json({ error: 'Failed to resume ad on Meta' }, { status: 500 });

    return NextResponse.json({ success: true, adExternalId });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
