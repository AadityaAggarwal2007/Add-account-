import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

// POST /api/telegram/report
// Called by cron every 5 minutes. Sends:
//  - Today's total spend + sales (from metrics DB)
//  - Ads paused in the last 5 minutes
//  - Total ads currently auto-paused
//
// CRON SETUP (cron-job.org):
//   URL: https://www.krvvy.info/api/telegram/report
//   Method: POST
//   Header: x-cron-secret: <CRON_SECRET_KEY>
//   Schedule: Every 5 minutes
export const maxDuration = 60;

export async function POST(request) {
  const cronSecret    = request.headers.get('x-cron-secret');
  const manualTrigger = request.headers.get('x-manual-trigger');

  if (!manualTrigger && cronSecret !== process.env.CRON_SECRET_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const rawIds = process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '';
  const chatIds = rawIds.split(',').map(id => id.trim()).filter(Boolean);

  if (!token || chatIds.length === 0) {
    return NextResponse.json({
      error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID(S) not set',
    }, { status: 500 });
  }

  try {
    const message = await buildReport();
    await Promise.all(chatIds.map(id => sendTelegram(token, id, message)));
    return NextResponse.json({ success: true, sentTo: chatIds.length });
  } catch (err) {
    console.error('[TelegramReport]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

async function buildReport() {
  const supabase = getSupabaseServer();

  // IST "today" date — same logic as live-rule-evaluator
  const nowMs    = Date.now();
  const istMs    = nowMs + (5.5 * 60 * 60 * 1000);
  const todayStr = new Date(istMs).toISOString().split('T')[0]; // YYYY-MM-DD

  const [
    { data: cronData },
    { data: todayMetrics },
    { data: pausedLast5Min },
    { data: currentlyPaused },
  ] = await Promise.all([
    // Cron health
    supabase.from('system_settings').select('value').eq('key', 'cron_health').single(),

    // Today's aggregated spend + conversions from metrics table
    supabase
      .from('metrics')
      .select('spend, conversions')
      .eq('date', todayStr),

    // Ads paused in the last 5 minutes
    supabase
      .from('automation_logs')
      .select('entity_name, rule_name, condition_snapshot, created_at')
      .eq('action_type', 'pause_ad')
      .eq('status', 'executed')
      .gte('created_at', new Date(nowMs - 5 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false }),

    // All currently auto-paused ads
    supabase
      .from('automation_paused_ads')
      .select('ad_name, rule_name, paused_at')
      .eq('is_paused', true)
      .order('paused_at', { ascending: false })
      .limit(10),
  ]);

  // ── Aggregate today's totals ─────────────────────────────
  const todayRows   = todayMetrics || [];
  const todaySpend  = todayRows.reduce((s, r) => s + (parseFloat(r.spend)       || 0), 0);
  const todaySales  = todayRows.reduce((s, r) => s + (parseFloat(r.conversions) || 0), 0);

  // ── Cron health ──────────────────────────────────────────
  const cronAgeMs = cronData?.value?.last_run_at
    ? nowMs - new Date(cronData.value.last_run_at).getTime() : null;
  const cronOk = cronAgeMs !== null && cronAgeMs < 3 * 60 * 1000;

  // ── Build message ────────────────────────────────────────
  const timeStr = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: true,
    day: 'numeric', month: 'short',
  });

  const lines = [];

  lines.push('<b>📊 Ad Report — ' + timeStr + ' IST</b>');
  lines.push('');

  // ── Today's performance ──────────────────────────────────
  lines.push('<b>Today\'s Performance</b>');
  lines.push('💰 Total Spend: Rs.' + todaySpend.toFixed(0));
  lines.push('🛒 Total Sales: ' + Math.round(todaySales));
  if (todaySales > 0) {
    lines.push('📈 Avg CPR: Rs.' + (todaySpend / todaySales).toFixed(0));
  }
  lines.push('');

  // ── Ads paused in last 5 min ─────────────────────────────
  const recent = pausedLast5Min || [];
  if (recent.length > 0) {
    lines.push('<b>⏸ Ads Stopped Last 5 Min: ' + recent.length + '</b>');
    for (const p of recent) {
      const snap = p.condition_snapshot || {};
      const details = [];
      if (snap.spend   != null)          details.push('Spend Rs.' + parseFloat(snap.spend).toFixed(0));
      if (snap.results != null)          details.push('Sales: '   + snap.results);
      if (snap.cpr && snap.cpr < 999998) details.push('CPR Rs.'   + parseFloat(snap.cpr).toFixed(0));
      if (snap.clicks  != null)          details.push('Clicks: '  + snap.clicks);
      lines.push('- ' + truncate(p.entity_name || 'Unknown', 40));
      if (details.length > 0) lines.push('  ' + details.join(' | '));
      if (p.rule_name) lines.push('  Rule: ' + p.rule_name);
    }
  } else {
    lines.push('⏸ No ads stopped in last 5 min');
  }
  lines.push('');

  // ── Currently paused ─────────────────────────────────────
  const allPaused = currentlyPaused || [];
  lines.push('🔴 Total Paused Now: ' + allPaused.length);
  if (allPaused.length > 0) {
    for (const p of allPaused.slice(0, 5)) {
      lines.push('  · ' + truncate(p.ad_name || 'Unknown', 35) + ' (' + fmtAge(nowMs - new Date(p.paused_at).getTime()) + ')');
    }
    if (allPaused.length > 5) lines.push('  · ... and ' + (allPaused.length - 5) + ' more');
  }
  lines.push('');

  // ── Cron status ───────────────────────────────────────────
  const cronStatus = cronOk ? '🟢 Running' : '🔴 Down';
  const cronAge    = cronAgeMs !== null ? ' (' + fmtAge(cronAgeMs) + ')' : ' (never)';
  lines.push('Cron: ' + cronStatus + cronAge);

  return lines.join('\n');
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.description || 'Telegram API error ' + res.status);
  }
  return res.json();
}

function fmtAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's ago';
  return Math.floor(s / 60) + 'm ago';
}

function truncate(str, max) {
  if (!str) return 'Unknown';
  return str.length > max ? str.slice(0, max) + '...' : str;
}
