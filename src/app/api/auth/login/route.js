import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { queryOne, query } from '@/lib/db';
import { verifyPassword, signToken } from '@/lib/auth';

const AUTH_COOKIE = 'meta_ads_session';

// POST /api/auth/login — Validate credentials, set session cookie
export async function POST(request) {
  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }

    const signingSecret = process.env.ADMIN_PASSWORD;
    if (!signingSecret) {
      return NextResponse.json({ error: 'Auth not configured on server' }, { status: 500 });
    }

    let authenticatedRole = null;
    let displayName = null;

    // === STEP 1: Check users table in DB ===
    try {
      const user = await queryOne(
        `SELECT id, username, display_name, password_hash, password_salt, role, is_active
         FROM users WHERE username = $1`,
        [username]
      );

      if (user) {
        if (!user.is_active) {
          return NextResponse.json({ error: 'Account is deactivated' }, { status: 403 });
        }

        const passwordValid = await verifyPassword(password, user.password_hash, user.password_salt);
        if (!passwordValid) {
          return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
        }

        authenticatedRole = user.role;
        displayName = user.display_name || user.username;

        // Update last login
        await query(
          `UPDATE users SET last_login_at = now() WHERE id = $1`,
          [user.id]
        );
      }
    } catch {
      // Users table might not exist yet — fall through to env check
    }

    // === STEP 2: Fallback to env-based admin ===
    if (!authenticatedRole) {
      const validUser = process.env.ADMIN_USERNAME;
      const validPass = process.env.ADMIN_PASSWORD;

      if (!validUser || !validPass) {
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
      }

      if (username !== validUser || password !== validPass) {
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
      }

      authenticatedRole = 'admin';
      displayName = 'Admin';
    }

    // === STEP 3: Create signed session token ===
    const timestamp = Date.now();
    const payload = `${username}:${authenticatedRole}:${timestamp}`;
    const signature = await signToken(payload, signingSecret);
    const token = btoa(`${payload}:${signature}`);

    const cookieStore = await cookies();
    cookieStore.set(AUTH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    });

    return NextResponse.json({ success: true, role: authenticatedRole, displayName });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    return NextResponse.json({ error: 'Login failed' }, { status: 500 });
  }
}

// DELETE /api/auth/login — Logout (clear cookie)
export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.set(AUTH_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  return NextResponse.json({ success: true });
}
