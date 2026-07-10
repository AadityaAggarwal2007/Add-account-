import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

export const maxDuration = 60;

export async function POST(request) {
  const cronSecret    = request.headers.get('x-cron-secret');
  const manualTrigger = request.headers.get('x-manual-trigger');

  if (!manualTrigger && cronSecret !== process.env.CRON_SECRET_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const rawIds  = process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '';
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

  const [
    { data: cronData },
    { data: localData },
    { data: pausedLast5Min },
    { data: currentlyPaused },
  ] = await Promise.all([
    supabase.from('system_settings').select('value').eq('key', 'cron_health').single(),
    supabase.from('system_settings').select('value').eq('key', 'local_poller_health').single(),
    supabase.from('automation_logs')
      .select('entity_name, rule_name, condition_snapshot, created_at')
      .eq('action_type', 'pause_ad')
      .eq('status', 'executed')
      .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false }),
    supabase.from('automation_paused_ads')
      .select('ad_name, rule_name, paused_at')
      .eq('is_paused', true)
      .order('paused_at', { ascending: false })
      .limit(5),
  ]);

  const cronAgeMs  = cronData?.value?.last_run_at
    ? Date.now() - new Date(cronData.value.last_run_at).getTime() : null;
  const localAgeMs = localData?.value?.last_run_at
    ? Date.now() - new Date(localData.value.last_run_at).getTime() : null;

  const cronOk  = cronAgeMs  !== null && cronAgeMs  < 3 * 60 * 1000;
  const localOk = localAgeMs !== null && localAgeMs < 30 * 1000;

  const timeStr = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: true,
    day: 'numeric', month: 'short',
  });

  const lines = [];

  lines.push('<b>Ad Report ' + timeStr + ' IST</b>');
  lines.push('');

  lines.push('<b>System Status</b>');
  const cronStatus  = cronOk  ? 'Running' : 'Down';
  const localStatus = localOk ? 'LIVE'    : 'Offline';
  const cronAge     = cronAgeMs  !== null ? ' (' + fmtAge(cronAgeMs)  + ')' : ' (never)';
  const localAge    = localAgeMs !== null ? ' (' + fmtAge(localAgeMs) + ')' : '';
  lines.push('Cron: ' + cronStatus + cronAge);
  lines.push('Local Poller: ' + localStatus + localAge);
  lines.push('');

  const recent = pausedLast5Min || [];
  if (recent.length > 0) {
    lines.push('<b>Ads Closed This Run: ' + recent.length + '</b>');
    for (const p of recent) {
      const snap = p.condition_snapshot || {};
      const details = [];
      if (snap.spend   != null)          details.push('Spend Rs.' + parseFloat(snap.spend).toFixed(0));
      if (snap.results != null)          details.push('Sales: ' + snap.results);
      if (snap.cpr && snap.cpr < 999998) details.push('CPR Rs.' + parseFloat(snap.cpr).toFixed(0));
      if (snap.clicks  != null)          details.push('Clicks: ' + snap.clicks);
      lines.push('- ' + truncate(p.entity_name || 'Unknown', 35));
      if (details.length > 0) lines.push('  ' + details.join(' | '));
      if (p.rule_name) lines.push('  Rule: ' + p.rule_name);
    }
  } else {
    lines.push('No ads closed this run');
  }
  lines.push('');

  const allPaused = currentlyPaused || [];
  lines.push('Total Ads Currently Paused: ' + allPaused.length);

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
