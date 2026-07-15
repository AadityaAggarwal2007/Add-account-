// ============================================================
// LOCAL POLLER — DISABLED
//
// This script has been removed. Do NOT run it.
// The 15-second local polling was causing Meta API rate limit
// bans on the ad account.
//
// Evaluation is handled ONLY by the 1-minute cron job at:
//   https://www.krvvy.info/api/automation/live-evaluate
//
// Set up via cron-job.org:
//   Method: POST
//   Header: x-cron-secret: <CRON_SECRET_KEY>
//   Schedule: Every 1 minute
// ============================================================

console.error('❌ Local poller is disabled. Use the cron job instead.');
process.exit(1);
