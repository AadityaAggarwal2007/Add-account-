import { NextResponse } from 'next/server';
import { verifySignature } from '@/lib/auth';

const AUTH_COOKIE = 'meta_ads_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// Paths that don't require authentication
const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/favicon.ico',
  '/auth/meta/callback',   // Meta OAuth callback — must be public or code is lost
  '/privacy',              // Public pages for Meta App Review
  '/terms',
];

// Paths that use their own auth (cron secret)
const CRON_PATHS = [
  '/api/sync',
  '/api/automation/evaluate',
  '/api/automation/live-evaluate',
  '/api/telegram/report',
];

// Paths that require admin or developer role (write operations)
const WRITE_API_PATHS = [
  '/api/campaigns/action',
  '/api/ad-performance/action',
  '/api/users',
];

// Paths that require admin role only
const ADMIN_ONLY_PATHS = [
  '/api/users',
  '/user-management',
];

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  // Allow static assets
  if (pathname.startsWith('/_next/') || pathname.startsWith('/static/') || pathname.endsWith('.ico') || pathname.endsWith('.png') || pathname.endsWith('.svg')) {
    return NextResponse.next();
  }

  // Cron paths have their own auth — let them through (they check CRON_SECRET_KEY)
  if (CRON_PATHS.some(p => pathname === p)) {
    const hasCronSecret = request.headers.get('x-cron-secret');
    if (hasCronSecret) return NextResponse.next();
  }

  // Check session cookie
  const sessionCookie = request.cookies.get(AUTH_COOKIE);

  if (!sessionCookie?.value) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Validate session token
  try {
    const decoded = atob(sessionCookie.value);
    const parts = decoded.split(':');

    // Support both old format (username:timestamp:sig) and new (username:role:timestamp:sig)
    let username, role, timestamp, signature;
    if (parts.length === 4) {
      [username, role, timestamp, signature] = parts;
    } else if (parts.length === 3) {
      // Legacy format — treat as admin (env-based login)
      [username, timestamp, signature] = parts;
      role = 'admin';
    } else {
      throw new Error('Invalid token format');
    }

    const signingSecret = process.env.ADMIN_PASSWORD;
    if (!signingSecret) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 500 });
    }

    // Verify HMAC signature (constant-time comparison)
    const payload = parts.length === 4
      ? `${username}:${role}:${timestamp}`
      : `${username}:${timestamp}`;
    const isValid = await verifySignature(payload, signature, signingSecret);

    if (!isValid) {
      const response = pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'Invalid session' }, { status: 401 })
        : NextResponse.redirect(new URL('/login', request.url));
      response.cookies.set(AUTH_COOKIE, '', { maxAge: 0, path: '/' });
      return response;
    }

    // Check if token is expired
    const tokenAge = Date.now() - parseInt(timestamp);
    if (tokenAge > SESSION_MAX_AGE) {
      const response = pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'Session expired' }, { status: 401 })
        : NextResponse.redirect(new URL('/login', request.url));
      response.cookies.set(AUTH_COOKIE, '', { maxAge: 0, path: '/' });
      return response;
    }

    // === ROLE-BASED ACCESS CONTROL ===

    // Admin-only paths
    if (ADMIN_ONLY_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
      if (role !== 'admin') {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
        }
        return NextResponse.redirect(new URL('/dashboard', request.url));
      }
    }

    // Write API paths — viewer cannot access
    if (WRITE_API_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
      if (role === 'viewer') {
        return NextResponse.json({ error: 'View-only access — action not permitted' }, { status: 403 });
      }
    }

    // Automation rule create/update/delete — viewer cannot access
    if (pathname === '/api/automation' && request.method !== 'GET') {
      if (role === 'viewer') {
        return NextResponse.json({ error: 'View-only access — action not permitted' }, { status: 403 });
      }
    }

    // Comments write operations (block/delete/bulk) — viewer cannot access
    if ((pathname === '/api/comments' || pathname.startsWith('/api/comments/')) && request.method !== 'GET') {
      if (role === 'viewer') {
        return NextResponse.json({ error: 'View-only access — action not permitted' }, { status: 403 });
      }
    }

    // Pass role info to downstream via headers (for API routes to use)
    const response = NextResponse.next();
    response.headers.set('x-user-role', role);
    response.headers.set('x-user-name', username);
    return response;

  } catch {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }
    const response = NextResponse.redirect(new URL('/login', request.url));
    response.cookies.set(AUTH_COOKIE, '', { maxAge: 0, path: '/' });
    return response;
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image).*)',
  ],
};
