// Scrapes Google Maps' "3 suggested routes" driving-time list between two fixed
// addresses in Brisbane, on a schedule described in README.md, and appends
// one record per route to data/readings.json.
//
// Why scraping instead of the Directions API: no Google Cloud billing/API key
// was available for this project, so we drive a real Maps page instead.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', 'data', 'readings.json');

// Suburb-only labels for anything public-facing (dashboard, data file) - the
// exact street addresses used to query Google Maps are kept out of the repo
// entirely and read from GitHub Actions secrets instead (see README.md).
const ORIGIN_LABEL = 'Pallara';
const DEST_LABEL = 'Eight Mile Plains';
const ORIGIN_ADDRESS = process.env.ORIGIN_ADDRESS;
const DEST_ADDRESS = process.env.DEST_ADDRESS;

if (!ORIGIN_ADDRESS || !DEST_ADDRESS) {
  console.error('ORIGIN_ADDRESS and DEST_ADDRESS must be set (see README.md - GitHub Actions secrets).');
  process.exit(1);
}

// The 11 weekdays this project monitors (Australia/Brisbane calendar dates).
const TARGET_DATES = [
  '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17',
  '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24',
  '2026-09-25',
];
const WINDOW_START_MIN = 7 * 60; // 7:00am
const WINDOW_END_MIN = 19 * 60; // 7:00pm

function getBrisbaneParts(date) {
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

function parseRoutes(fullText) {
  const text = fullText;
  // Matches "1 hr 5 min" style (real route durations) and plain "34 min".
  // Deliberately does NOT match the "1h 19m" mode-switcher ETAs shown at the
  // top of the page (transit/walk/cycle icons), which use a bare "h"/"m"
  // with no "min"/"hr" word - those would otherwise be false positives.
  const durationRe = /(\d+)\s*hr\s*(\d{1,2})?\s*min|(\d{1,3})\s*min\b/g;
  const found = [];
  let m;
  while ((m = durationRe.exec(text)) !== null) {
    let minutes;
    if (m[1]) {
      minutes = Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0);
    } else {
      minutes = Number(m[3]);
    }
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 180) continue;

    // A real route card has its distance within a few characters of the
    // duration (e.g. "22 min\n21.9 km\nvia M2\n..."). The mode-switcher ETAs
    // and "Recents" list also contain bare "N min" text but with no distance
    // nearby, so requiring one close by filters those false positives out.
    const context = text.slice(m.index, m.index + 160);
    const distMatch = context.match(/(\d+(?:[.,]\d+)?)\s*km/);
    if (!distMatch || distMatch.index > 40) continue;

    const viaMatch = context.match(/via\s+([^\n]{1,60})/i);

    found.push({
      duration_text: m[0].replace(/\s+/g, ' ').trim(),
      duration_minutes: minutes,
      distance_text: distMatch[0].trim(),
      via: viaMatch ? viaMatch[1].trim() : null,
      index: m.index,
    });
  }

  // Dedupe near-duplicate matches (same duration+distance within a short span)
  const deduped = [];
  for (const r of found) {
    const dup = deduped.find(d => d.duration_minutes === r.duration_minutes
      && d.distance_text === r.distance_text
      && Math.abs(d.index - r.index) < 200);
    if (!dup) deduped.push(r);
  }

  return deduped.slice(0, 3);
}

async function dismissConsentIfPresent(page) {
  const selectors = [
    'button:has-text("Accept all")',
    'button:has-text("I agree")',
    'form[action*="consent"] button',
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(1500);
        return;
      }
    } catch {
      // selector not present, keep trying
    }
  }
}

async function scrapeRoutes(origin, destination) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    headless: true,
  });
  try {
    const context = await browser.newContext({
      locale: 'en-AU',
      timezoneId: 'Australia/Brisbane',
      viewport: { width: 1366, height: 1000 },
    });
    const page = await context.newPage();
    // Not logged: the URL (and Google's resolved redirect URL) embed both
    // addresses and, once resolved, their precise coordinates.
    const url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving&avoid=tolls`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await dismissConsentIfPresent(page);

    try {
      await page.waitForFunction(() => /\bmin\b/.test(document.body.innerText), { timeout: 25000 });
    } catch {
      console.log('Timed out waiting for a "min" duration to appear on the page.');
    }
    // Let alternative routes finish rendering.
    await page.waitForTimeout(4000);

    const bodyText = await page.evaluate(() => document.body.innerText);
    if (process.env.DEBUG_DUMP_PAGE_TEXT === 'true') {
      // Off by default: the page text echoes the input street names (e.g. a
      // "Recents" entry), which we don't want in (potentially public) logs.
      console.log('--- page.body.innerText (first 4000 chars) ---');
      console.log(bodyText.slice(0, 4000));
      console.log('--- end innerText snippet ---');
    }

    const routes = parseRoutes(bodyText);
    console.log('Parsed routes:', JSON.stringify(routes, null, 2));

    return { routes };
  } finally {
    await browser.close();
  }
}

function loadExistingData() {
  if (!existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveData(records) {
  mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(records, null, 2) + '\n');
}

async function main() {
  const force = process.env.FORCE_RUN === 'true';
  const now = new Date();
  const { dateStr, hour, minute } = getBrisbaneParts(now);
  const totalMin = hour * 60 + minute;

  console.log(`Brisbane time now: ${dateStr} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);

  if (!force) {
    if (!TARGET_DATES.includes(dateStr)) {
      console.log(`${dateStr} is not one of the 10 monitored weekdays. Skipping.`);
      return;
    }
    if (totalMin < WINDOW_START_MIN || totalMin > WINDOW_END_MIN) {
      console.log('Outside the 7am-7pm Brisbane collection window. Skipping.');
      return;
    }
  } else {
    console.log('FORCE_RUN=true — bypassing date/time gating for a test run.');
  }

  const beforeMidday = hour < 12;
  const direction = beforeMidday ? 'pallara_to_emp' : 'emp_to_pallara';
  const origin = beforeMidday ? ORIGIN_ADDRESS : DEST_ADDRESS;
  const destination = beforeMidday ? DEST_ADDRESS : ORIGIN_ADDRESS;
  const originLabel = beforeMidday ? ORIGIN_LABEL : DEST_LABEL;
  const destLabel = beforeMidday ? DEST_LABEL : ORIGIN_LABEL;

  console.log(`Direction: ${originLabel} -> ${destLabel} (${direction})`);

  const { routes } = await scrapeRoutes(origin, destination);

  if (routes.length === 0) {
    console.error('No routes parsed from the page. Failing so this run is visible in the Actions log.');
    process.exitCode = 1;
  }

  const timestampUtc = now.toISOString();
  const records = loadExistingData();

  routes.forEach((route, i) => {
    records.push({
      timestamp_utc: timestampUtc,
      date_brisbane: dateStr,
      time_brisbane: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      direction,
      origin_label: originLabel,
      dest_label: destLabel,
      route_index: i + 1,
      duration_minutes: route.duration_minutes,
      duration_text: route.duration_text,
      distance_text: route.distance_text,
      via: route.via,
    });
  });

  saveData(records);
  console.log(`Appended ${routes.length} route reading(s). Total records: ${records.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
