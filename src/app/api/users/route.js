import { NextResponse } from 'next/server';
import { queryRows, queryOne, query } from '@/lib/db';
import { hashPassword, generateSalt } from '@/lib/auth';

// GET /api/users — List all users (admin only — enforced by middleware)
export async function GET() {
  try {
    const users = await queryRows(
      `SELECT id, username, display_name, role, is_active, last_login_at, created_at
       FROM users ORDER BY created_at ASC`
    );
    return NextResponse.json({ users });
  } catch (err) {
    console.error('Users list error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/users — Create a new user (admin only)
export async function POST(request) {
  const { username, password, displayName, role } = await request.json();

  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }
  const validRoles = ['admin', 'developer', 'viewer'];
  if (role && !validRoles.includes(role)) {
    return NextResponse.json({ error: `Invalid role. Must be: ${validRoles.join(', ')}` }, { status: 400 });
  }
  if (username === process.env.ADMIN_USERNAME) {
    return NextResponse.json({ error: 'This username is reserved' }, { status: 400 });
  }

  try {
    const existing = await queryOne(`SELECT id FROM users WHERE username = $1`, [username]);
    if (existing) {
      return NextResponse.json({ error: 'Username already taken' }, { status: 409 });
    }

    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt);

    const user = await queryOne(
      `INSERT INTO users (username, display_name, password_hash, password_salt, role, is_active)
       VALUES ($1,$2,$3,$4,$5,true)
       RETURNING id, username, display_name, role, is_active, created_at`,
      [username, displayName || username, passwordHash, salt, role || 'viewer']
    );

    return NextResponse.json({ user });
  } catch (err) {
    console.error('User create error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// PATCH /api/users — Update user (role, active status, password reset)
export async function PATCH(request) {
  const { id, role, isActive, password, displayName } = await request.json();

  if (!id) return NextResponse.json({ error: 'User id required' }, { status: 400 });

  try {
    const setClauses = ['updated_at = now()'];
    const params = [];

    if (role !== undefined) {
      const validRoles = ['admin', 'developer', 'viewer'];
      if (!validRoles.includes(role)) return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
      params.push(role);
      setClauses.push(`role = $${params.length}`);
    }
    if (isActive !== undefined) {
      params.push(isActive);
      setClauses.push(`is_active = $${params.length}`);
    }
    if (displayName !== undefined) {
      params.push(displayName);
      setClauses.push(`display_name = $${params.length}`);
    }
    if (password) {
      if (password.length < 8) return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);
      params.push(hash, salt);
      setClauses.push(`password_hash = $${params.length - 1}`, `password_salt = $${params.length}`);
    }

    params.push(id);
    const user = await queryOne(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${params.length}
       RETURNING id, username, display_name, role, is_active`,
      params
    );

    return NextResponse.json({ user });
  } catch (err) {
    console.error('User update error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE /api/users — Delete a user (admin only)
export async function DELETE(request) {
  const { id } = await request.json();
  if (!id) return NextResponse.json({ error: 'User id required' }, { status: 400 });

  try {
    await query(`DELETE FROM users WHERE id = $1`, [id]);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('User delete error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
