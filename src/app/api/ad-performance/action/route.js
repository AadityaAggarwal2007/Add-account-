import { NextResponse } from 'next/server';
import { queryOne, queryRows, query } from '@/lib/db';
import {
  pauseCampaign, enableCampaign,
  pauseAdSet, enableAdSet,
  pauseAd, enableAd,
} from '@/lib/meta-api';

// POST /api/ad-performance/action — Pause/Enable campaigns, ad sets, or ads
export async function POST(request) {
  const { entityId, entityType, action } = await request.json();

  if (!entityId || !entityType || !action) {
    return NextResponse.json({ error: 'entityId, entityType, and action required' }, { status: 400 });
  }
  if (!['pause', 'enable'].includes(action)) {
    return NextResponse.json({ error: 'action must be pause or enable' }, { status: 400 });
  }

  try {
    let externalId = entityId;
    let entityName = entityId;

    if (entityType === 'campaign') {
      const campaign = await queryOne(
        `SELECT c.id, c.external_id, c.name, ma.access_token
         FROM campaigns c
         JOIN meta_accounts ma ON c.meta_account_id = ma.id
         WHERE c.id = $1`,
        [entityId]
      );
      if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
      if (!campaign.access_token) return NextResponse.json({ error: 'No access token' }, { status: 400 });

      externalId = campaign.external_id;
      entityName = campaign.name;

      if (action === 'pause') await pauseCampaign(externalId, campaign.access_token);
      else await enableCampaign(externalId, campaign.access_token);

      await query(
        `UPDATE campaigns SET status = $1, updated_at = now() WHERE id = $2`,
        [action === 'pause' ? 'PAUSED' : 'ACTIVE', entityId]
      );
    } else {
      // Ad Set or Ad — entityId IS the external Meta ID
      const accounts = await queryRows(
        `SELECT id, access_token, name FROM meta_accounts WHERE is_active = true`
      );
      if (!accounts.length) return NextResponse.json({ error: 'No active accounts' }, { status: 400 });

      let success = false;
      for (const account of accounts) {
        try {
          if (entityType === 'adset') {
            if (action === 'pause') await pauseAdSet(entityId, account.access_token);
            else await enableAdSet(entityId, account.access_token);
          } else {
            if (action === 'pause') await pauseAd(entityId, account.access_token);
            else await enableAd(entityId, account.access_token);
          }
          success = true;
          break;
        } catch { continue; }
      }
      if (!success) return NextResponse.json({ error: `Failed to ${action} ${entityType}` }, { status: 500 });
    }

    const actionLabel = action === 'pause' ? '⏸️ Paused' : '▶️ Enabled';
    const typeLabel = entityType === 'campaign' ? 'Campaign' : entityType === 'adset' ? 'Ad Set' : 'Ad';
    await query(
      `INSERT INTO notifications (type, title, message, severity) VALUES ($1,$2,$3,$4)`,
      ['automation_fired', `${actionLabel}: ${entityName}`, `${typeLabel} ${action === 'pause' ? 'paused' : 'enabled'}`, 'info']
    );

    return NextResponse.json({ success: true, action, entityType });
  } catch (err) {
    console.error('Ad performance action error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
