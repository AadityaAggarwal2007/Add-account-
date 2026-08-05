import { NextResponse } from 'next/server';
import { queryRows, queryOne } from '@/lib/db';

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
    return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID(S) not set' }, { status: 500 });
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
  const nowMs    = Date.now();
  const istMs    = nowMs + (5.5 * 60 * 60 * 1000);
  const todayStr = new Date(istMs).toISOString().split('T')[0];

  const [cronData, todayMetrics, pausedLast5Min, currentlyPaused] = await Promise.all([
    queryOne(`SELECT value FROM system_settings WHERE key = 'cron_health'`),
    queryRows(`SELECT spend, conversions FROM metrics WHERE date = $1`, [todayStr]),
    queryRows(
      `SELECT entity_name, rule_name, condition_snapshot, created_at FROM automation_logs
       WHERE action_type = 'pause_ad' AND status = 'executed' AND created_at >= $1
       ORDER BY created_at DESC`,
      [new Date(nowMs - 5 * 60 * 1000).toISOString()]
    ),
    queryRows(
      `SELECT ad_name, rule_name, paused_at FROM automation_paused_ads
       WHERE is_paused = true ORDER BY paused_at DESC LIMIT 10`
    ),
  ]);

  const todaySpend = todayMetrics.reduce((s, r) => s + (parseFloat(r.spend) || 0), 0);
  const todaySales = todayMetrics.reduce((s, r) => s + (parseFloat(r.conversions) || 0), 0);

  const cronAgeMs = cronData?.value?.last_run_at
    ? nowMs - new Date(cronData.value.last_run_at).getTime() : null;
  const cronOk = cronAgeMs !== null && cronAgeMs < 3 * 60 * 1000;

  const timeStr = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true, day: 'numeric', month: 'short',
  });

  const lines = [];
  lines.push('<b>📊 Ad Report — ' + timeStr + ' IST</b>');
  lines.push('');
  lines.push('<b>Today\'s Performance</b>');
  lines.push('💰 Total Spend: Rs.' + todaySpend.toFixed(0));
  lines.push('🛒 Total Sales: ' + Math.round(todaySales));
  if (todaySales > 0) lines.push('📈 Avg CPR: Rs.' + (todaySpend / todaySales).toFixed(0));
  lines.push('');

  if (pausedLast5Min.length > 0) {
    lines.push('<b>⏸ Ads Stopped Last 5 Min: ' + pausedLast5Min.length + '</b>');
    for (const p of pausedLast5Min) {
      const snap = p.condition_snapshot || {};
      const details = [];
      if (snap.spend != null)          details.push('Spend Rs.' + parseFloat(snap.spend).toFixed(0));
      if (snap.results != null)        details.push('Sales: '   + snap.results);
      if (snap.cpr && snap.cpr < 999998) details.push('CPR Rs.' + parseFloat(snap.cpr).toFixed(0));
      if (snap.clicks != null)         details.push('Clicks: '  + snap.clicks);
      lines.push('- ' + truncate(p.entity_name || 'Unknown', 40));
      if (details.length > 0) lines.push('  ' + details.join(' | '));
      if (p.rule_name) lines.push('  Rule: ' + p.rule_name);
    }
  } else {
    lines.push('⏸ No ads stopped in last 5 min');
  }
  lines.push('');

  lines.push('🔴 Total Paused Now: ' + currentlyPaused.length);
  if (currentlyPaused.length > 0) {
    for (const p of currentlyPaused.slice(0, 5)) {
      lines.push('  · ' + truncate(p.ad_name || 'Unknown', 35) + ' (' + fmtAge(nowMs - new Date(p.paused_at).getTime()) + ')');
    }
    if (currentlyPaused.length > 5) lines.push('  · ... and ' + (currentlyPaused.length - 5) + ' more');
  }
  lines.push('');

  const cronStatus = cronOk ? '🟢 Running' : '🔴 Down';
  const cronAge    = cronAgeMs !== null ? ' (' + fmtAge(cronAgeMs) + ')' : ' (never)';
  lines.push('Cron: ' + cronStatus + cronAge);

  return lines.join('\n');
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.description || 'Telegram API error ' + res.status); }
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
