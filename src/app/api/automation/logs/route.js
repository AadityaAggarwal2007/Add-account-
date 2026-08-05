import { NextResponse } from 'next/server';
import { queryRows, queryOne, query } from '@/lib/db';

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

    // TODO: Execute the reversal via Meta API using log.previous_value
    await query(
      `UPDATE automation_logs SET is_reversed = true, reversed_at = now() WHERE id = $1`,
      [logId]
    );

    return NextResponse.json({ success: true, message: 'Action reversed' });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
