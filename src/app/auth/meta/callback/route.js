import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { exchangeCodeForToken, fetchAdAccounts } from '@/lib/meta-api';

const META_GRAPH_URL = 'https://graph.facebook.com/v22.0';

async function fetchAllPageTokens(userAccessToken) {
  const pages = [];
  let url = `${META_GRAPH_URL}/me/accounts?fields=id,name,access_token,instagram_business_account&limit=100&access_token=${userAccessToken}`;
  while (url) {
    const res = await fetch(url);
    if (!res.ok) break;
    const json = await res.json();
    for (const p of (json.data || [])) {
      pages.push({
        page_id: p.id,
        page_name: p.name,
        page_access_token: p.access_token,
        instagram_account_id: p.instagram_business_account?.id || null,
      });
    }
    url = json.paging?.next || null;
  }
  return pages;
}

// Meta OAuth callback — exchanges code for token, saves accounts + page tokens
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  // Always use the public domain (from Nginx forwarded headers), not internal localhost
  const fwdHost = request.headers.get('x-forwarded-host') || new URL(request.url).host;
  const fwdProto = request.headers.get('x-forwarded-proto') || 'https';
  const baseUrl = `${fwdProto}://${fwdHost}`;
  const redirectUri = `${baseUrl}/auth/meta/callback`;

  if (error) {
    return NextResponse.redirect(`${baseUrl}/settings?error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return NextResponse.redirect(`${baseUrl}/settings?error=no_code`);
  }

  try {
    const { accessToken, expiresIn } = await exchangeCodeForToken(code, redirectUri);

    const [accounts, pageTokens] = await Promise.all([
      fetchAdAccounts(accessToken),
      fetchAllPageTokens(accessToken),
    ]);

    // expiresIn may be undefined for long-lived tokens — default to 60 days
    const expiresSeconds = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 60 * 24 * 3600;
    const expiresAt = new Date(Date.now() + expiresSeconds * 1000).toISOString();

    // Bulk upsert ad accounts
    for (const acct of accounts) {
      await query(
        `INSERT INTO meta_accounts
           (meta_account_id, name, currency, timezone, status, is_active, access_token, token_expires_at)
         VALUES ($1,$2,$3,$4,$5,true,$6,$7)
         ON CONFLICT (meta_account_id) DO UPDATE SET
           name = EXCLUDED.name, currency = EXCLUDED.currency, timezone = EXCLUDED.timezone,
           status = EXCLUDED.status, is_active = true,
           access_token = EXCLUDED.access_token, token_expires_at = EXCLUDED.token_expires_at,
           updated_at = now()`,
        [
          acct.metaAccountId, acct.name, acct.currency, acct.timezone,
          acct.isActive ? 'active' : 'inactive', accessToken, expiresAt,
        ]
      );
    }

    // Bulk upsert page tokens
    for (const page of pageTokens) {
      await query(
        `INSERT INTO page_tokens
           (page_id, page_name, page_access_token, instagram_account_id, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (page_id) DO UPDATE SET
           page_name = EXCLUDED.page_name,
           page_access_token = EXCLUDED.page_access_token,
           instagram_account_id = EXCLUDED.instagram_account_id,
           updated_at = now()`,
        [page.page_id, page.page_name, page.page_access_token, page.instagram_account_id]
      );
    }

    console.log(`[OAuth] Connected: ${accounts.length} ad accounts, ${pageTokens.length} pages`);

    return NextResponse.redirect(
      `${baseUrl}/settings?connected=true&accounts=${accounts.length}&pages=${pageTokens.length}`
    );
  } catch (err) {
    console.error('Meta OAuth callback error:', err);
    return NextResponse.redirect(
      `${baseUrl}/settings?error=${encodeURIComponent(err.message)}`
    );
  }
}
