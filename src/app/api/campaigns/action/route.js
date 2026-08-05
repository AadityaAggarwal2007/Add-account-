import { NextResponse } from 'next/server';
import { queryOne, query } from '@/lib/db';
import { pauseCampaign, enableCampaign, updateBudget } from '@/lib/meta-api';

// POST /api/campaigns/action — Quick actions on campaigns
export async function POST(request) {
  const { campaignId, action, value } = await request.json();

  if (!campaignId || !action) {
    return NextResponse.json({ error: 'campaignId and action required' }, { status: 400 });
  }

  try {
    const campaign = await queryOne(
      `SELECT id, external_id, name, status, meta_account_id FROM campaigns WHERE id = $1`,
      [campaignId]
    );

    if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });

    const account = await queryOne(
      `SELECT access_token FROM meta_accounts WHERE id = $1`,
      [campaign.meta_account_id]
    );

    if (!account?.access_token) return NextResponse.json({ error: 'No access token' }, { status: 400 });

    let result;
    let newStatus = campaign.status;

    switch (action) {
      case 'pause':
        result = await pauseCampaign(campaign.external_id, account.access_token);
        newStatus = 'PAUSED';
        break;
      case 'enable':
        result = await enableCampaign(campaign.external_id, account.access_token);
        newStatus = 'ACTIVE';
        break;
      case 'set_budget':
        if (!value || value <= 0) return NextResponse.json({ error: 'Invalid budget value' }, { status: 400 });
        result = await updateBudget(campaign.external_id, value, account.access_token);
        await query(`UPDATE campaigns SET daily_budget = $1 WHERE id = $2`, [value, campaignId]);
        break;
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    if (action !== 'set_budget') {
      await query(
        `UPDATE campaigns SET status = $1, updated_at = now() WHERE id = $2`,
        [newStatus, campaignId]
      );
    }

    await query(
      `INSERT INTO notifications (type, title, message, severity)
       VALUES ($1,$2,$3,$4)`,
      [
        'automation_fired',
        `${action === 'pause' ? '⏸️ Paused' : action === 'enable' ? '▶️ Enabled' : '💰 Budget updated'}: ${campaign.name}`,
        action === 'set_budget' ? `Budget set to $${value}` : `Campaign ${newStatus}`,
        'info',
      ]
    );

    return NextResponse.json({ success: true, status: newStatus, result });
  } catch (err) {
    console.error('Campaign action error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
