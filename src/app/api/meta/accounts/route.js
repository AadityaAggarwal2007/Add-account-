import { NextResponse } from 'next/server';
import { queryRows, query } from '@/lib/db';

// GET — list accounts
export async function GET() {
  try {
    const accounts = await queryRows(
      `SELECT id, meta_account_id, name, currency, timezone, status, is_active, last_synced_at, created_at
       FROM meta_accounts
       ORDER BY created_at DESC`
    );
    return NextResponse.json({ accounts });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// PATCH — toggle account active status
export async function PATCH(request) {
  const { id, is_active } = await request.json();

  try {
    await query(
      `UPDATE meta_accounts SET is_active = $1, updated_at = now() WHERE id = $2`,
      [is_active, id]
    );
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
