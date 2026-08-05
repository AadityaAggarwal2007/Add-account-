import { NextResponse } from 'next/server';
import { queryRows } from '@/lib/db';

export async function GET() {
  try {
    const blocked = await queryRows(
      `SELECT * FROM blocked_accounts ORDER BY blocked_at DESC`
    );
    return NextResponse.json({ blocked });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
