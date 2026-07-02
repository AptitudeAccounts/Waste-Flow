/**
 * Email alerts. Two mechanisms:
 *  1. maybeSendThresholdAlert_() runs inline after every submission and fires
 *     immediately if an outlet's waste cost for that day crosses the
 *     configured threshold (Settings > DailyAlertThresholdAED).
 *  2. sendWeeklySummary() is meant to be run on a time-driven trigger
 *     (Apps Script > Triggers > Add Trigger > Time-driven > Week timer).
 *     It is NOT wired up automatically — see README "Enabling email alerts".
 */

function getSetting_(key, fallback) {
  const rows = readAll_(SHEET_NAMES.SETTINGS);
  const row = rows.find(r => r.Key === key);
  return row ? row.Value : fallback;
}

function maybeSendThresholdAlert_(outlet, date) {
  const alertEmail = getSetting_('AlertEmail', '');
  if (!alertEmail) return; // Alerts are off until an AlertEmail is set.

  const threshold = Number(getSetting_('DailyAlertThresholdAED', 0));
  if (!threshold) return;

  const rows = readAll_(SHEET_NAMES.LOG).filter(r =>
    r.Status !== 'Deleted' && r.Outlet === outlet && String(r.Date) === String(date)
  );
  const total = rows.reduce((s, r) => s + (Number(r.EstimatedCost) || 0), 0);
  if (total < threshold) return;

  // Avoid spamming: only send once per outlet per day using a cache flag.
  const flagKey = 'alertSent_' + outlet + '_' + date;
  const cache = CacheService.getScriptCache();
  if (cache.get(flagKey)) return;
  cache.put(flagKey, '1', 20 * 60 * 60);

  const currency = getSetting_('CurrencySymbol', 'AED');
  const company = getSetting_('CompanyName', 'WasteFlow');
  const subject = `[${company}] Daily waste threshold exceeded — ${outlet}`;
  const body =
    `${outlet} has recorded ${currency} ${total.toFixed(2)} in waste on ${date}, ` +
    `which is over the configured threshold of ${currency} ${threshold}.\n\n` +
    `Log in to the WasteFlow dashboard to review the entries.`;
  MailApp.sendEmail(alertEmail, subject, body);
}

/** Set up with a weekly time-driven trigger. Sends a rollup of the last 7 days per outlet. */
function sendWeeklySummary() {
  const alertEmail = getSetting_('AlertEmail', '');
  if (!alertEmail) return;

  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmt = d => Utilities.formatDate(d, 'Asia/Dubai', 'yyyy-MM-dd');

  const rows = readAll_(SHEET_NAMES.LOG).filter(r =>
    r.Status !== 'Deleted' && String(r.Date) >= fmt(weekAgo) && String(r.Date) <= fmt(today)
  );

  const byOutlet = {};
  rows.forEach(r => {
    byOutlet[r.Outlet] = byOutlet[r.Outlet] || { cost: 0, entries: 0 };
    byOutlet[r.Outlet].cost += Number(r.EstimatedCost) || 0;
    byOutlet[r.Outlet].entries += 1;
  });

  const currency = getSetting_('CurrencySymbol', 'AED');
  const company = getSetting_('CompanyName', 'WasteFlow');
  const lines = Object.keys(byOutlet).sort((a, b) => byOutlet[b].cost - byOutlet[a].cost)
    .map(o => `  ${o}: ${currency} ${byOutlet[o].cost.toFixed(2)} across ${byOutlet[o].entries} entries`);

  const subject = `[${company}] Weekly waste summary — ${fmt(weekAgo)} to ${fmt(today)}`;
  const body = `Waste recorded across all outlets this week:\n\n${lines.join('\n')}\n\nLog in to the dashboard for full detail.`;
  MailApp.sendEmail(alertEmail, subject, body);
}

/** Manual test hook, also available from the WasteFlow sheet menu. */
function sendDailyAlertEmail() {
  const alertEmail = getSetting_('AlertEmail', '');
  if (!alertEmail) {
    SpreadsheetApp.getUi().alert('Set an AlertEmail value in the Settings tab first.');
    return;
  }
  MailApp.sendEmail(alertEmail, 'WasteFlow test alert', 'This is a test email from your WasteFlow system. If you received this, alerts are configured correctly.');
  SpreadsheetApp.getUi().alert('Test email sent to ' + alertEmail);
}
