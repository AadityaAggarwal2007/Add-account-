import { NextResponse } from 'next/server';
import { queryOne, query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// GET /api/settings/exchange-rate
export async function GET() {
  try {
    const row = await queryOne(
      `SELECT value FROM system_settings WHERE key = 'usd_to_inr_rate'`
    );
    return NextResponse.json({ rate: row?.value?.rate || 84.5 });
  } catch {
    return NextResponse.json({ rate: 84.5 });
  }
}

// POST /api/settings/exchange-rate — Update exchange rate
export async function POST(request) {
  const { rate } = await request.json();
  if (!rate || rate <= 0) {
    return NextResponse.json({ error: 'Invalid rate' }, { status: 400 });
  }

  try {
    await query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('usd_to_inr_rate', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
      [JSON.stringify({ rate, last_updated: new Date().toISOString().split('T')[0] })]
    );
    return NextResponse.json({ success: true, rate });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
