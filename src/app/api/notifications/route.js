import { NextResponse } from 'next/server';
import { queryRows, queryOne, query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// GET — list notifications
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const unreadOnly = searchParams.get('unread') === 'true';
  const limit = parseInt(searchParams.get('limit') || '20');

  try {
    const rows = await queryRows(
      `SELECT * FROM notifications
       ${unreadOnly ? 'WHERE is_read = false' : ''}
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    const countRow = await queryOne(
      `SELECT COUNT(*) as count FROM notifications WHERE is_read = false`
    );

    return NextResponse.json({
      notifications: rows,
      unreadCount: parseInt(countRow?.count || '0'),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST — mark notifications as read
export async function POST(request) {
  const { ids, markAll } = await request.json();

  try {
    if (markAll) {
      await query(`UPDATE notifications SET is_read = true WHERE is_read = false`);
    } else if (ids?.length) {
      await query(
        `UPDATE notifications SET is_read = true WHERE id = ANY($1::uuid[])`,
        [ids]
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
