import { NextResponse } from 'next/server';
import { queryRows } from '@/lib/db';
import { fetchAdCreativeMedia } from '@/lib/meta-api';

export const dynamic = 'force-dynamic';

// GET /api/ad-performance/media?adId=META_AD_ID
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const adId = searchParams.get('adId');

  if (!adId) return NextResponse.json({ error: 'adId required' }, { status: 400 });

  try {
    const accounts = await queryRows(
      `SELECT id, access_token FROM meta_accounts WHERE is_active = true`
    );
    if (!accounts.length) return NextResponse.json({ error: 'No active accounts' }, { status: 400 });

    for (const account of accounts) {
      try {
        const media = await fetchAdCreativeMedia(adId, account.access_token);
        if (media.url) return NextResponse.json(media);
      } catch { continue; }
    }

    return NextResponse.json({ type: 'image', url: null });
  } catch (err) {
    console.error('Media fetch error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
