// Decides whether scripts/collect.mjs should actually scrape right now,
// based on the monitored dates/window (Australia/Brisbane). Deliberately
// dependency-free (no playwright import) so collect.yml can run this as an
// early, cheap check before installing Chromium - an external pinger now
// triggers the workflow every 10 minutes around the clock (GitHub's native
// `schedule:` trigger is best-effort and unreliable at this frequency), so
// most pings land outside the window and should skip in a couple of seconds
// rather than paying for a ~25s Chromium install first.

import { appendFileSync } from 'node:fs';

// Every Monday-Friday (Australia/Brisbane calendar date) is monitored, with no
// end date. Weekends are skipped. site/index.html applies the same rule when
// deciding which readings to show.
export function isWeekday(dateStr) {
  const day = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return day >= 1 && day <= 5;
}
export const WINDOW_START_MIN = 6 * 60; // 6:00am
export const WINDOW_END_MIN = 18 * 60; // 6:00pm

export function getBrisbaneParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Brisbane',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
  };
}

export function decide(now = new Date(), force = false) {
  const { dateStr, hour, minute } = getBrisbaneParts(now);
  const totalMin = hour * 60 + minute;

  if (force) {
    return { shouldRun: true, dateStr, hour, minute, reason: 'FORCE_RUN=true — bypassing date/time gating for a test run.' };
  }
  if (!isWeekday(dateStr)) {
    return { shouldRun: false, dateStr, hour, minute, reason: `${dateStr} is a weekend. Skipping.` };
  }
  if (totalMin < WINDOW_START_MIN || totalMin > WINDOW_END_MIN) {
    return { shouldRun: false, dateStr, hour, minute, reason: 'Outside the 6am-6pm Brisbane collection window. Skipping.' };
  }
  return { shouldRun: true, dateStr, hour, minute, reason: 'In the monitored window.' };
}

// CLI entry point (`node scripts/gate.mjs`): print the decision and, inside
// GitHub Actions, write should_run to $GITHUB_OUTPUT for the step to branch on.
if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.env.FORCE_RUN === 'true';
  const { shouldRun, dateStr, hour, minute, reason } = decide(new Date(), force);
  console.log(`Brisbane time now: ${dateStr} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  console.log(reason);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `should_run=${shouldRun}\n`);
  }
}
