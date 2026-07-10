// ============================================================
// LOCAL AD POLLER — Runs every 15 seconds from your machine
// ============================================================
// Usage:  node poll.js
// Keep this terminal open while you want 15s polling active.
// Your Automation page will show "🖥️ Local: 🟢 LIVE" when running.
// ============================================================

const fs   = require('fs');
const path = require('path');

// Load .env.local manually (no dotenv dependency needed)
function loadEnv() {
  const envPath = path.join(__dirname, '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

const ENDPOINT = 'https://www.krvvy.info/api/automation/live-evaluate';
const SECRET   = process.env.CRON_SECRET_KEY;
const INTERVAL = 15_000; // 15 seconds

if (!SECRET) {
  console.error('❌  CRON_SECRET_KEY not found in .env.local — cannot start');
  process.exit(1);
}

let runCount = 0;

async function runEvaluation() {
  runCount++;
  const start = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-cron-secret':  SECRET,
        'x-local-poller': 'true',
      },
    });

    const data = await res.json();

    if (data.error) {
      console.error(`[${ts()}] #${runCount} ❌ ${data.error}`);
    } else {
      const parts = [
        `✅ ${data.evaluated ?? 0} ads`,
        `${data.rules ?? 0} rules`,
        `${data.elapsed_ms ?? (Date.now() - start)}ms`,
      ];
      if ((data.paused  ?? 0) > 0) parts.push(`⏸  ${data.paused} paused`);
      if ((data.resumed ?? 0) > 0) parts.push(`▶  ${data.resumed} resumed`);
      if ((data.skipped ?? 0) > 0) parts.push(`⏭  ${data.skipped} skipped`);
      console.log(`[${ts()}] #${runCount} ${parts.join(' — ')}`);
    }
  } catch (e) {
    console.error(`[${ts()}] #${runCount} ❌ Network error: ${e.message}`);
  }
}

function ts() {
  return new Date().toLocaleTimeString('en-IN', { hour12: true });
}

console.log('');
console.log('🚀 Local Ad Poller — every 15 seconds');
console.log(`   Hitting: ${ENDPOINT}`);
console.log('   Keep this terminal open. Close it to stop.');
console.log('   Your Automation page → "🖥️ Local" indicator shows LIVE/Offline.');
console.log('');

runEvaluation();                    // fire immediately on start
setInterval(runEvaluation, INTERVAL); // then every 15s
