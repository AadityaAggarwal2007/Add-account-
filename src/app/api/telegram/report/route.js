import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

// POST /api/telegram/report
// Sends a performance summary to Telegram.
// Call manually (x-manual-trigger) or via cron (x-cron-secret).
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN  — from @BotFather
//   TELEGRAM_CHAT_ID    — your personal chat ID
//
export const maxDuration = 60;

const META_GRAPH_URL = 'https://graph.facebook.com/v22.0';

const CONVERSION_PRIORITY = [
  'purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase',
  'lead', 'offsite_conversion.fb_pixel_lead',
  'complete_registration', 'offsite_conversion.fb_pixel_complete_registration',
  'add_to_cart', 'omni_add_to_cart',
];

export async function POST(request) {
  const cronSecret    = request.headers.get('x-cron-secret');
  const manualTrigger = request.headers.get('x-manual-trigger');

  if (!manualTrigger && cronSecret !== process.env.CRON_SECRET_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;

  // Support multiple recipients:
  // TELEGRAM_CHAT_IDS = comma-separated list (e.g. "123456,789012")
  // Falls back to TELEGRAM_CHAT_ID for single recipient
  const rawIds  = process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '';
  const chatIds = rawIds.split(',').map(id => id.trim()).filter(Boolean);

  if (!token || chatIds.length === 0) {
    return NextResponse.json({
      error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID(S) not set in .env.local',
    }, { status: 500 });
  }

  try {
    const message = await buildReport();
    // Send to ALL recipients in parallel
    await Promise.all(chatIds.map(id => sendTelegram(token, id, message)));
    return NextResponse.json({ success: true, sentTo: chatIds.length });
  } catch (err) {
    console.error('[TelegramReport]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────
// REPORT BUILDER
// ─────────────────────────────────────────────────────────────

async function buildReport() {
  const supabase = getSupabaseServer();

  // Load everything in parallel
  const [
    { data: accounts },
    { data: cronData },
    { data: localData },
    { data: rules },
    { data: pausedLast5Min },
    { data: pausedTodayAll },
    { data: currentlyPaused },
  ] = await Promise.all([
    supabase.from('meta_accounts').select('meta_account_id, access_token, name').eq('is_active', true),
    supabase.from('system_settings').select('value').eq('key', 'cron_health').single(),
    supabase.from('system_settings').select('value').eq('key', 'local_poller_health').single(),
    supabase.from('automation_rules').select('*').eq('is_active', true).in('scope', ['ad', 'ad_set']),
    // Paused in last 5 minutes — full details
    supabase.from('automation_logs')
      .select('entity_name, entity_external_id, rule_name, condition_snapshot, created_at')
      .eq('action_type', 'pause_ad')
      .eq('status', 'executed')
      .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false }),
    // All paused today (count only)
    supabase.from('automation_logs')
      .select('id', { count: 'exact', head: true })
      .eq('action_type', 'pause_ad')
      .eq('status', 'executed')
      .gte('created_at', startOfTodayIST()),
    // Currently still paused — full details
    supabase.from('automation_paused_ads')
      .select('ad_name, rule_name, paused_at, metric_snapshot, reason')
      .eq('is_paused', true)
      .order('paused_at', { ascending: false })
      .limit(15),
  ]);

  // Fetch live insights from Meta
  let allInsights = [];
  if (accounts?.length) {
    const arrays = await Promise.all(
      accounts.map(acc =>
        fetchTodayInsights(acc.meta_account_id, acc.access_token).catch(() => [])
      )
    );
    allInsights = arrays.flat();
  }

  // ── Totals ────────────────────────────────────────────────
  const totalClicks = allInsights.reduce((s, i) => s + i.clicks, 0);
  const totalSales  = allInsights.reduce((s, i) => s + i.results, 0);
  const totalSpend  = allInsights.reduce((s, i) => s + i.spend, 0);
  const totalAds    = allInsights.length;

  // ── Top 3 by sales ────────────────────────────────────────
  const top3 = [...allInsights]
    .filter(i => i.results > 0)
    .sort((a, b) => b.results - a.results)
    .slice(0, 3);

  // ── At-risk ads (CPR within 80–99% of rule threshold) ────
  const atRisk = getAtRiskAds(allInsights, rules || []);

  // ── System health ─────────────────────────────────────────
  const cronAgeMs  = cronData?.value?.last_run_at
    ? Date.now() - new Date(cronData.value.last_run_at).getTime() : null;
  const localAgeMs = localData?.value?.last_run_at
    ? Date.now() - new Date(localData.value.last_run_at).getTime() : null;

  const cronOk  = cronAgeMs  !== null && cronAgeMs  < 3 * 60 * 1000;   // < 3 min
  const localOk = localAgeMs !== null && localAgeMs < 30 * 1000;        // < 30s

  const timeStr = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: true,
    day: 'numeric', month: 'short',
  });

  // ── Build HTML message ────────────────────────────────────
  const lines = [];

  lines.push(`📊 <b>Ad Report — ${timeStr} IST</b>`);
  lines.push('');

  // System health
  lines.push('🤖 <b>System Status</b>');
  lines.push(`• Cron-job.org: ${cronOk ? '🟢 Running' : '🔴 Down'} ${cronAgeMs !== null ? `(${fmtAge(cronAgeMs)})` : '(never)'}`);
  lines.push(`• Local Poller: ${localOk ? '🟢 LIVE 15s' : '⚪ Offline'} ${localAgeMs !== null ? `(${fmtAge(localAgeMs)})` : ''}`);
  lines.push('');

  // Today's performance
  lines.push('📈 <b>Today\'s Performance</b>');
  lines.push(`• Ads reporting: <b>${totalAds}</b>`);
  lines.push(`• Clicks: <b>${totalClicks.toLocaleString()}</b>`);
  lines.push(`• Sales: <b>${totalSales.toLocaleString()}</b>`);
  lines.push(`• Spend: <b>₹${totalSpend.toFixed(0)}</b>`);
  if (totalSales > 0) {
    lines.push(`• Avg CPR: <b>₹${(totalSpend / totalSales).toFixed(0)}</b>`);
  }
  lines.push('');

  // ── PAUSED IN LAST 5 MINUTES — full detail ───────────────
  const recentPauses = pausedLast5Min || [];
  if (recentPauses.length > 0) {
    lines.push(`🚨 <b>JUST PAUSED (last 5 min): ${recentPauses.length} ads</b>`);
    for (const p of recentPauses) {
      const name = truncate(p.entity_name || 'Unknown', 32);
      const snap = p.condition_snapshot || {};
      lines.push(`⏸ <b>${name}</b>`);
      const details = [];
      if (snap.cpr   && snap.cpr < 999999) details.push(`CPR ₹${parseFloat(snap.cpr).toFixed(0)}`);
      if (snap.spend)                       details.push(`Spend ₹${parseFloat(snap.spend).toFixed(0)}`);
      if (snap.results != null)             details.push(`Sales: ${snap.results}`);
      if (snap.clicks)                      details.push(`Clicks: ${snap.clicks}`);
      if (p.rule_name)                      details.push(`Rule: "${truncate(p.rule_name, 20)}"`);
      if (details.length) lines.push(`   ${details.join(' | ')}`);
    }
    lines.push('');
  }

  // Top 3 ads
  if (top3.length > 0) {
    lines.push('🏆 <b>Top 3 Ads (by sales today)</b>');
    top3.forEach((ad, i) => {
      const medal = ['🥇', '🥈', '🥉'][i];
      lines.push(`${medal} <b>${truncate(ad.entityName, 30)}</b>`);
      lines.push(`   ${ad.results} sales | CPR ₹${ad.cpr?.toFixed(0)} | Spend ₹${ad.spend?.toFixed(0)} | Clicks ${ad.clicks}`);
    });
    lines.push('');
  } else {
    lines.push('🏆 <b>Top Ads:</b> No sales recorded yet today');
    lines.push('');
  }

  // At risk
  if (atRisk.length > 0) {
    lines.push('⚠️ <b>Edge of Being Paused</b>');
    for (const ad of atRisk.slice(0, 5)) {
      const pct  = Math.round((ad.cpr / ad.threshold) * 100);
      lines.push(`• <b>${truncate(ad.entityName, 28)}</b>`);
      lines.push(`  CPR ₹${ad.cpr?.toFixed(0)} / limit ₹${ad.threshold} — ${pct}% of threshold`);
    }
    lines.push('');
  } else {
    lines.push('✅ <b>No ads near pause threshold</b>');
    lines.push('');
  }

  // ── CURRENTLY PAUSED — full detail ───────────────────────
  const stillPaused = currentlyPaused || [];
  const todayTotal  = pausedTodayAll?.length || 0;

  lines.push(`⏸️ <b>Currently Paused by Rules: ${stillPaused.length} ads</b>`);
  lines.push(`   (${todayTotal} paused total today)`);

  if (stillPaused.length > 0) {
    for (const p of stillPaused.slice(0, 8)) {
      const name   = truncate(p.ad_name || 'Unknown', 30);
      const snap   = p.metric_snapshot || {};
      const isKill = p.reason === 'kill_switch';
      lines.push(`${isKill ? '💀' : '⏸'} <b>${name}</b>`);
      const details = [];
      if (snap.cpr && snap.cpr < 999999) details.push(`CPR ₹${parseFloat(snap.cpr).toFixed(0)}`);
      if (snap.spend)                    details.push(`Spend ₹${parseFloat(snap.spend).toFixed(0)}`);
      if (snap.results != null)          details.push(`Sales ${snap.results}`);
      if (p.rule_name)                   details.push(`"${truncate(p.rule_name, 20)}"`);
      if (isKill)                        details.push('💀 No resume');
      if (details.length) lines.push(`   ${details.join(' | ')}`);
    }
    if (stillPaused.length > 8) {
      lines.push(`   ...and ${stillPaused.length - 8} more paused`);
    }
  } else {
    lines.push('   No ads currently paused ✅');
  }

  return lines.join('\n');
}


// ─────────────────────────────────────────────────────────────
// AT-RISK ADS — CPR between 80–99% of rule threshold
// ─────────────────────────────────────────────────────────────

function getAtRiskAds(insights, rules) {
  const atRisk = [];
  const seen   = new Set();

  for (const rule of rules) {
    for (const cond of (rule.conditions || [])) {
      if (cond.metric !== 'cpr' && cond.metric !== 'cost_per_result') continue;
      if (cond.operator !== '>') continue;
      const threshold = parseFloat(cond.value);
      if (!threshold) continue;

      for (const ad of insights) {
        if (!ad.cpr || ad.cpr <= 0 || ad.cpr >= threshold) continue;
        if (ad.spend < 1) continue; // skip zero/micro spend
        const pct = ad.cpr / threshold;
        if (pct >= 0.80 && !seen.has(ad.entityId)) {
          seen.add(ad.entityId);
          atRisk.push({ ...ad, threshold, ruleName: rule.name, pct });
        }
      }
    }
  }

  return atRisk.sort((a, b) => b.pct - a.pct); // highest risk first
}


// ─────────────────────────────────────────────────────────────
// META API — Today's ad insights
// ─────────────────────────────────────────────────────────────

async function fetchTodayInsights(accountId, accessToken) {
  const now    = new Date();
  const istMs  = now.getTime() + (5.5 * 60 * 60 * 1000);
  const today  = new Date(istMs).toISOString().split('T')[0];
  const timeRange   = encodeURIComponent(JSON.stringify({ since: today, until: today }));
  const spendFilter = encodeURIComponent(
    JSON.stringify([{ field: 'spend', operator: 'GREATER_THAN', value: '0' }])
  );

  let url = `${META_GRAPH_URL}/act_${accountId}/insights?` +
    `fields=ad_id,ad_name,spend,impressions,clicks,actions` +
    `&level=ad&time_range=${timeRange}&filtering=${spendFilter}&limit=500` +
    `&access_token=${accessToken}`;

  const rows = [];
  while (url) {
    const res = await fetch(url);
    if (!res.ok) break;
    const json = await res.json();
    if (json.data?.length) rows.push(...json.data);
    url = json.paging?.next || null;
  }

  return rows.map(row => {
    const spend       = parseFloat(row.spend || '0');
    const clicks      = parseInt(row.clicks || '0');
    const impressions = parseInt(row.impressions || '0');
    const results     = extractConversions(row.actions);
    const cpr         = results > 0
      ? +(spend / results).toFixed(2)
      : (spend > 0 ? 999999 : 0);
    return { entityId: row.ad_id, entityName: row.ad_name, spend, clicks, impressions, results, cpr };
  });
}

function extractConversions(actions) {
  if (!Array.isArray(actions)) return 0;
  for (const type of CONVERSION_PRIORITY) {
    const a = actions.find(a => a.action_type === type);
    if (a) return parseFloat(a.value || '0');
  }
  return 0;
}


// ─────────────────────────────────────────────────────────────
// TELEGRAM SENDER
// ─────────────────────────────────────────────────────────────

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.description || `Telegram API error ${res.status}`);
  }
  return res.json();
}


// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function startOfTodayIST() {
  const now   = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  const today = new Date(istMs).toISOString().split('T')[0];
  return `${today}T00:00:00.000Z`;
}

function fmtAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function truncate(str, max) {
  if (!str) return 'Unknown';
  return str.length > max ? str.slice(0, max) + '…' : str;
}
