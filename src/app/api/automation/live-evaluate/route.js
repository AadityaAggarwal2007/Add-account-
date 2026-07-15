import { NextResponse } from 'next/server';
import { evaluateLiveRules } from '@/lib/live-rule-evaluator';
import { getSupabaseServer } from '@/lib/supabase-server';

// POST /api/automation/live-evaluate
// Called by CRON every 60 seconds. Fetches live Meta data and evaluates ad rules.
//
// CRON SETUP (cron-job.org — free):
//   URL: https://www.krvvy.info/api/automation/live-evaluate
//   Method: POST
//   Header: x-cron-secret: YOUR_CRON_SECRET_KEY
//   Schedule: Every 1 minute
//
// Vercel timeout: 300s (set below) — needed for 500+ ads with parallel pauses
export const maxDuration = 300;
export async function POST(request) {
  // Auth: cron secret OR manual trigger
  const cronSecret    = request.headers.get('x-cron-secret');
  const manualTrigger = request.headers.get('x-manual-trigger');

  if (!manualTrigger && cronSecret !== process.env.CRON_SECRET_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const source = manualTrigger ? 'manual' : 'cron';

  try {
    const result = await evaluateLiveRules();
    const supabase = getSupabaseServer();
    const now = new Date().toISOString();

    const healthPayload = {
      last_run_at:   now,
      source,
      status:        'success',
      evaluated:     result.evaluated    || 0,
      paused:        result.paused       || 0,
      resumed:       result.resumed      || 0,
      skipped:       result.skipped      || result.skippedMinSpend || 0,
      rules_checked: result.rules        || 0,
      elapsed_ms:    result.elapsed_ms   || 0,
      error:         null,
    };

    // ── Update cron_health ──
    await supabase.from('system_settings').upsert(
      { key: 'cron_health', value: healthPayload, updated_at: now },
      { onConflict: 'key' }
    );

    return NextResponse.json({ ...result, source });
  } catch (err) {
    console.error('[LiveEvaluate] Error:', err);

    try {
      const supabase = getSupabaseServer();
      const now = new Date().toISOString();
      const errPayload = { last_run_at: now, source, status: 'failed', error: err.message };
      await supabase.from('system_settings').upsert(
        { key: 'cron_health', value: errPayload, updated_at: now },
        { onConflict: 'key' }
      );
    } catch {}

    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// GET /api/automation/live-evaluate — cron health check
export async function GET() {
  try {
    const supabase = getSupabaseServer();

    const { data: cronData } = await supabase
      .from('system_settings')
      .select('value, updated_at')
      .eq('key', 'cron_health')
      .single();

    if (!cronData?.value) {
      return NextResponse.json({
        status: 'never_run',
        message: 'Cron has never executed.',
        healthy: false,
      });
    }

    const lastRun = new Date(cronData.value.last_run_at);
    const ageMs   = Date.now() - lastRun.getTime();
    const ageMins = Math.floor(ageMs / 60000);

    let health = 'healthy';
    let healthColor = 'green';
    if (ageMins > 10) { health = 'critical'; healthColor = 'red'; }
    else if (ageMins > 3) { health = 'warning'; healthColor = 'yellow'; }

    return NextResponse.json({
      healthy:      health === 'healthy',
      health,
      healthColor,
      lastRunAt:    cronData.value.last_run_at,
      lastRunAge:   ageMins < 1 ? 'just now' : `${ageMins}m ago`,
      lastRunAgeMs: ageMs,
      source:       cronData.value.source,
      status:       cronData.value.status,
      lastResult: {
        evaluated:    cronData.value.evaluated,
        paused:       cronData.value.paused,
        resumed:      cronData.value.resumed,
        skipped:      cronData.value.skipped,
        rulesChecked: cronData.value.rules_checked,
        elapsedMs:    cronData.value.elapsed_ms,
        error:        cronData.value.error,
      },
    });
  } catch (err) {
    return NextResponse.json({ healthy: false, health: 'error', error: err.message });
  }
}
