import { NextResponse } from 'next/server';
import { queryRows, query } from '@/lib/db';
import { detectSpam } from '@/lib/spam-keywords';

export const dynamic = 'force-dynamic';

const META_GRAPH_URL = 'https://graph.facebook.com/v18.0';
const FB_FIELDS = 'id,message,from{name,id},created_time,like_count,comment_count,is_hidden,attachment';
const IG_FIELDS = 'id,text,timestamp,from{id,username},like_count,hidden,replies{id}';

async function getPageTokens(userAccessToken) {
  const pages = {}, igMap = {};

  try {
    let url = `${META_GRAPH_URL}/me/accounts?fields=id,name,access_token,instagram_business_account&limit=100&access_token=${userAccessToken}`;
    while (url) {
      const res = await fetch(url);
      if (!res.ok) break;
      const json = await res.json();
      for (const p of (json.data || [])) {
        pages[p.id] = { token: p.access_token, name: p.name };
        if (p.instagram_business_account?.id) igMap[p.instagram_business_account.id] = p.id;
      }
      url = json.paging?.next || null;
    }
  } catch (e) { console.error('Page tokens error:', e.message); }

  try {
    const storedPages = await queryRows(
      `SELECT page_id, page_name, page_access_token, instagram_account_id FROM page_tokens`
    );
    for (const sp of storedPages) {
      if (!pages[sp.page_id] && sp.page_access_token) {
        pages[sp.page_id] = { token: sp.page_access_token, name: sp.page_name };
      }
      if (sp.instagram_account_id && !igMap[sp.instagram_account_id]) {
        igMap[sp.instagram_account_id] = sp.page_id;
      }
    }
  } catch (e) { console.error('Stored page tokens error:', e.message); }

  return { pages, igMap };
}

function getIgToken(igActorId, pages, igMap, fallback) {
  if (igActorId && igMap[igActorId] && pages[igMap[igActorId]]) return pages[igMap[igActorId]].token;
  for (const pageId of Object.values(igMap)) { if (pages[pageId]) return pages[pageId].token; }
  const first = Object.values(pages)[0];
  return first?.token || fallback;
}

async function batchFetchComments(items, fallbackToken) {
  if (!items.length) return [];
  const results = [];
  for (let i = 0; i < items.length; i += 50) {
    const chunk = items.slice(i, i + 50);
    const batch = chunk.map(p => ({
      method: 'GET',
      relative_url: `${p.postId}/comments?fields=${encodeURIComponent(p.fields)}&limit=25${p.isIG ? '' : '&order=reverse_chronological'}&access_token=${encodeURIComponent(p.token)}`,
    }));
    try {
      const res = await fetch(`${META_GRAPH_URL}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `access_token=${encodeURIComponent(fallbackToken)}&batch=${encodeURIComponent(JSON.stringify(batch))}`,
      });
      if (!res.ok) continue;
      const batchRes = await res.json();
      for (let j = 0; j < batchRes.length; j++) {
        if (batchRes[j]?.code === 200) {
          try { results.push({ item: chunk[j], comments: JSON.parse(batchRes[j].body).data || [] }); } catch {}
        }
      }
    } catch (e) { console.error('[Batch] Error:', e.message); }
  }
  return results;
}

// GET /api/comments
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get('account');
  const adFilter = searchParams.get('ad');
  const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 500);

  try {
    const accounts = accountId && accountId !== 'all'
      ? await queryRows(`SELECT id, meta_account_id, access_token, name FROM meta_accounts WHERE is_active = true AND id = $1`, [accountId])
      : await queryRows(`SELECT id, meta_account_id, access_token, name FROM meta_accounts WHERE is_active = true`);

    if (!accounts.length) return NextResponse.json({ comments: [], ads: [], total: 0 });

    const allComments = [], allAds = [];

    await Promise.all(accounts.map(async (account) => {
      try {
        const statusFilter = encodeURIComponent(JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }]));
        const adFields = 'id,name,status,creative{effective_object_story_id,effective_instagram_media_id,instagram_actor_id,thumbnail_url}';
        const adLimit = adFilter ? 200 : 20;

        const [{ pages, igMap }, adsRes] = await Promise.all([
          getPageTokens(account.access_token),
          fetch(`${META_GRAPH_URL}/act_${account.meta_account_id}/ads?fields=${adFields}&limit=${adLimit}${adFilter ? '' : `&filtering=${statusFilter}`}&access_token=${account.access_token}`),
        ]);

        if (!adsRes.ok) return;
        const adsData = (await adsRes.json()).data || [];
        if (!adsData.length) return;

        const batchItems = [];
        for (const ad of adsData) {
          const fbId = ad.creative?.effective_object_story_id;
          const igId = ad.creative?.effective_instagram_media_id;
          if (!fbId && !igId) continue;
          if (adFilter && ad.id !== adFilter) continue;

          const platform = igId ? (fbId ? 'both' : 'instagram') : 'facebook';
          const adMeta = { adId: ad.id, adName: ad.name, adStatus: ad.status, thumb: ad.creative?.thumbnail_url, accountName: account.name, accountId: account.id };
          allAds.push({ id: ad.id, name: ad.name, status: ad.status, postId: fbId || igId, thumbnailUrl: adMeta.thumb, platform, accountName: account.name, accountId: account.id });

          if (fbId) {
            const pageId = fbId.split('_')[0];
            batchItems.push({ postId: fbId, fields: FB_FIELDS, token: pages[pageId]?.token || account.access_token, isIG: false, ad: adMeta });
          }
          if (igId) {
            batchItems.push({ postId: igId, fields: IG_FIELDS, token: getIgToken(ad.creative?.instagram_actor_id, pages, igMap, account.access_token), isIG: true, ad: adMeta });
          }
        }

        const results = await batchFetchComments(batchItems, account.access_token);
        for (const { item, comments } of results) {
          const { ad, isIG, postId } = item;
          for (const c of comments) {
            allComments.push({
              id: c.id,
              message: isIG ? (c.text || '') : (c.message || ''),
              authorName: isIG ? (c.from?.username || c.username || 'Unknown') : (c.from?.name || 'Unknown'),
              authorId: c.from?.id || null,
              createdAt: isIG ? c.timestamp : c.created_time,
              likeCount: c.like_count || 0,
              replyCount: isIG ? (c.replies?.data?.length || 0) : (c.comment_count || 0),
              isHidden: isIG ? (c.hidden || false) : (c.is_hidden || false),
              hasAttachment: !isIG && !!c.attachment,
              attachmentType: c.attachment?.type || null,
              attachmentUrl: c.attachment?.media?.image?.src || c.attachment?.url || null,
              adId: ad.adId, adName: ad.adName, adStatus: ad.adStatus,
              thumbnailUrl: ad.thumb, postId,
              accountName: ad.accountName, accountId: ad.accountId,
              platform: isIG ? 'instagram' : 'facebook',
              ...detectSpam(isIG ? (c.text || '') : (c.message || '')),
            });
          }
        }
      } catch (e) { console.error(`[Comments] Account ${account.name}:`, e.message); }
    }));

    allComments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const seen = new Set(), uniqueAds = [];
    for (const ad of allAds) { if (!seen.has(ad.id)) { seen.add(ad.id); uniqueAds.push(ad); } }

    return NextResponse.json({ comments: allComments.slice(0, limit), ads: uniqueAds, total: allComments.length, totalSpam: allComments.filter(c => c.isSpam).length });
  } catch (e) {
    console.error('Comments API error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/comments — Reply, hide/unhide, delete, block, bulk_delete
export async function POST(request) {
  const body = await request.json();
  const { commentId, action, message, postId, platform, commentIds, userId, pageId, userName, reason } = body;
  if (!action) return NextResponse.json({ error: 'action required' }, { status: 400 });

  const isIG = platform === 'instagram';
  const accounts = await queryRows(`SELECT access_token FROM meta_accounts WHERE is_active = true`);
  if (!accounts.length) return NextResponse.json({ error: 'No active account' }, { status: 400 });

  if (action === 'bulk_delete') {
    if (!commentIds?.length) return NextResponse.json({ error: 'No comment IDs' }, { status: 400 });
    let deleted = 0, failed = 0;
    for (const account of accounts) {
      try {
        const { pages } = await getPageTokens(account.access_token);
        for (const cId of commentIds) {
          try {
            const commentPageId = cId.split('_')[0];
            const token = pages[commentPageId]?.token || Object.values(pages)[0]?.token || account.access_token;
            const res = await fetch(`${META_GRAPH_URL}/${cId}?access_token=${token}`, { method: 'DELETE' });
            if (res.ok) deleted++; else failed++;
          } catch { failed++; }
        }
        if (deleted > 0) break;
      } catch { continue; }
    }
    return NextResponse.json({ success: true, action: 'bulk_deleted', deleted, failed });
  }

  if (action === 'block') {
    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });
    for (const account of accounts) {
      try {
        const { pages } = await getPageTokens(account.access_token);
        const targetPageId = pageId || (postId ? postId.split('_')[0] : Object.keys(pages)[0]);
        const pageToken = pages[targetPageId]?.token || Object.values(pages)[0]?.token || account.access_token;
        const res = await fetch(`${META_GRAPH_URL}/${targetPageId}/blocked`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user: userId, access_token: pageToken }),
        });
        if (res.ok) {
          await query(
            `INSERT INTO blocked_accounts (page_id, user_id, user_name, reason, blocked_at)
             VALUES ($1,$2,$3,$4,now())
             ON CONFLICT (page_id, user_id) DO UPDATE SET user_name = $3, reason = $4, blocked_at = now()`,
            [targetPageId, userId, userName || 'Unknown', reason || 'Spam/Fake comment']
          );
          return NextResponse.json({ success: true, action: 'blocked', userId });
        }
      } catch { continue; }
    }
    return NextResponse.json({ error: 'Block failed' }, { status: 500 });
  }

  if (action === 'unblock') {
    if (!userId || !pageId) return NextResponse.json({ error: 'userId and pageId required' }, { status: 400 });
    for (const account of accounts) {
      try {
        const { pages } = await getPageTokens(account.access_token);
        const pageToken = pages[pageId]?.token || Object.values(pages)[0]?.token || account.access_token;
        const res = await fetch(`${META_GRAPH_URL}/${pageId}/blocked?user=${userId}&access_token=${pageToken}`, { method: 'DELETE' });
        if (res.ok) {
          await query(`DELETE FROM blocked_accounts WHERE page_id = $1 AND user_id = $2`, [pageId, userId]);
          return NextResponse.json({ success: true, action: 'unblocked', userId });
        }
      } catch { continue; }
    }
    return NextResponse.json({ error: 'Unblock failed' }, { status: 500 });
  }

  if (!commentId) return NextResponse.json({ error: 'commentId required' }, { status: 400 });

  let lastError = null;
  for (const account of accounts) {
    try {
      const { pages, igMap } = await getPageTokens(account.access_token);
      const possibleTokens = [];
      if (isIG) {
        for (const igId of Object.keys(igMap)) { const pId = igMap[igId]; if (pages[pId]?.token) possibleTokens.push(pages[pId].token); }
        if (!possibleTokens.length) possibleTokens.push(account.access_token);
      } else {
        const commentPageId = (postId || commentId).split('_')[0];
        possibleTokens.push(pages[commentPageId]?.token || Object.values(pages)[0]?.token || account.access_token);
      }

      for (const t of possibleTokens) {
        let res;
        if (action === 'reply') {
          if (!message) return NextResponse.json({ error: 'Message required' }, { status: 400 });
          res = await fetch(`${META_GRAPH_URL}/${commentId}/${isIG ? 'replies' : 'comments'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, access_token: t }) });
        } else if (action === 'hide' || action === 'unhide') {
          const hidePayload = isIG ? { hide: action === 'hide' } : { is_hidden: action === 'hide' };
          res = await fetch(`${META_GRAPH_URL}/${commentId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...hidePayload, access_token: t }) });
        } else if (action === 'delete') {
          res = await fetch(`${META_GRAPH_URL}/${commentId}?access_token=${t}`, { method: 'DELETE' });
        } else return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

        if (res.ok) return NextResponse.json({ success: true, action });
      }
      lastError = 'All tokens failed for this account';
    } catch (e) { lastError = e.message; }
  }
  return NextResponse.json({ error: lastError || 'All accounts failed' }, { status: 500 });
}
