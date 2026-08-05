import { NextResponse } from 'next/server';
import { queryRows } from '@/lib/db';

const META_GRAPH_URL = 'https://graph.facebook.com/v22.0';

// GET /api/automation/ads — Fetch all ads across all accounts for rule targeting picker
export async function GET() {
  try {
    const accounts = await queryRows(
      `SELECT id, meta_account_id, access_token, name
       FROM meta_accounts WHERE is_active = true`
    );

    if (!accounts.length) return NextResponse.json({ ads: [] });

    const allAds = [];

    await Promise.all(accounts.map(async (account) => {
      try {
        const fields = 'id,name,status,campaign{id,name},adset{id,name},creative{thumbnail_url}';
        const statusFilter = encodeURIComponent(
          JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }])
        );

        let url = `${META_GRAPH_URL}/act_${account.meta_account_id}/ads?fields=${fields}&filtering=${statusFilter}&limit=200&access_token=${account.access_token}`;

        while (url) {
          const res = await fetch(url);
          if (!res.ok) break;
          const json = await res.json();

          for (const ad of (json.data || [])) {
            allAds.push({
              externalId: ad.id,
              name: ad.name,
              status: ad.status,
              campaignId: ad.campaign?.id || null,
              campaignName: ad.campaign?.name || null,
              adsetId: ad.adset?.id || null,
              adsetName: ad.adset?.name || null,
              thumbnailUrl: ad.creative?.thumbnail_url || null,
              accountId: account.id,
              accountName: account.name,
              metaAccountId: account.meta_account_id,
            });
          }

          url = json.paging?.next || null;
        }
      } catch (err) {
        console.error(`[AdsAPI] Failed to fetch for ${account.name}:`, err.message);
      }
    }));

    return NextResponse.json({ ads: allAds, total: allAds.length });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
