import { NextResponse } from 'next/server';
import { queryRows, queryOne, query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// GET — list all automation rules
export async function GET() {
  try {
    const rules = await queryRows(
      `SELECT * FROM automation_rules ORDER BY created_at DESC`
    );
    return NextResponse.json({ rules });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST — create a new rule
export async function POST(request) {
  const body = await request.json();

  try {
    const rule = await queryOne(
      `INSERT INTO automation_rules
         (name, description, scope, conditions, action_type, action_params,
          cooldown_minutes, max_triggers_per_day, min_spend_threshold,
          requires_approval, dry_run, target_ids, target_account_ids, target_external_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        body.name,
        body.description || null,
        body.scope || 'campaign',
        JSON.stringify(body.conditions),
        body.action_type,
        body.action_params ? JSON.stringify(body.action_params) : null,
        0, // ZERO COOLDOWN: always instant pause & resume
        body.max_triggers_per_day || 10,
        body.min_spend_threshold ?? 1.00,
        body.requires_approval || false,
        body.dry_run || false,
        body.target_ids || null,
        body.target_account_ids || null,
        body.target_external_ids || null,
      ]
    );
    return NextResponse.json({ rule }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// PATCH — update a rule (toggle active, edit fields)
export async function PATCH(request) {
  const body = await request.json();
  const { id, ...updates } = body;

  if (!id) return NextResponse.json({ error: 'Missing rule id' }, { status: 400 });

  // Build dynamic SET clause
  const allowedFields = [
    'name', 'description', 'is_active', 'scope', 'conditions', 'action_type',
    'action_params', 'cooldown_minutes', 'max_triggers_per_day', 'min_spend_threshold',
    'requires_approval', 'dry_run', 'target_ids', 'target_account_ids', 'target_external_ids',
  ];

  const setClauses = [];
  const params = [];

  // Fields that are JSONB in Postgres — must be serialized
  const jsonbFields = new Set(['conditions', 'action_params']);

  for (const [key, val] of Object.entries(updates)) {
    if (!allowedFields.includes(key)) continue;
    // JSONB columns need explicit stringify; pg arrays (target_*) pass through as-is
    const serialized = jsonbFields.has(key) && val !== null
      ? JSON.stringify(val)
      : (typeof val === 'object' && val !== null && !Array.isArray(val) ? JSON.stringify(val) : val);
    params.push(serialized);
    setClauses.push(`${key} = $${params.length}`);
  }

  if (!setClauses.length) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });

  setClauses.push('updated_at = now()');
  params.push(id);

  try {
    const rule = await queryOne(
      `UPDATE automation_rules SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    return NextResponse.json({ rule });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE — delete a rule
export async function DELETE(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) return NextResponse.json({ error: 'Missing rule id' }, { status: 400 });

  try {
    await query(`DELETE FROM automation_rules WHERE id = $1`, [id]);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
