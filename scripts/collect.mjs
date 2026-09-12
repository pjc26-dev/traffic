// Scrapes Google Maps' "3 suggested routes" driving-time list between fixed
// address pairs in Brisbane, on a schedule described in README.md, and
// appends one record per route per pair to data/readings.json.
//
// Why scraping instead of the Directions API: no Google Cloud billing/API key
// was available for this project, so we drive a real Maps page instead.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decide } from './gate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', 'data', 'readings.json');

// Every route pair shares the same origin (one address, one secret). Labels
// here are for the public dashboard/data file only - the exact addresses
// are kept out of the repo entirely and read from GitHub Actions secrets
// (see README.md). Destinations 2-4 use generic labels by request, so real
// place names never appear in source, logs, or the dashboard.
const ORIGIN_LABEL = 'Pallara';
const ORIGIN_ADDRESS = process.env.ORIGIN_ADDRESS;

const ROUTES = [
  { id: 'route1', destLabel: 'EMP', destEnv: 'DEST_ADDRESS' },
  { id: 'route2', destLabel: 'Ox', destEnv: 'DEST_ADDRESS_2' },
  { id: 'route3', destLabel: 'Da', destEnv: 'DEST_ADDRESS_3' },
  { id: 'route4', destLabel: 'Co', destEnv: 'DEST_ADDRESS_4' },
];

if (!ORIGIN_ADDRESS) {
  console.error('ORIGIN_ADDRESS must be set (see README.md - GitHub Actions secrets).');
  process.exit(1);
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

async function scrapeRoutes(browser, origin, destination) {
  const context = await browser.newContext({
    locale: 'en-AU',
    timezoneId: 'Australia/Brisbane',
    viewport: { width: 1366, height: 1000 },
  });
  try {
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
    return routes;
  } finally {
    await context.close();
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
  const { shouldRun, dateStr, hour, minute, reason } = decide(now, force);

  console.log(`Brisbane time now: ${dateStr} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  console.log(reason);

  if (!shouldRun) return;

  const beforeMidday = hour < 12;
  const direction = beforeMidday ? 'am' : 'pm'; // am: origin -> dest, pm: dest -> origin
  const timeBrisbane = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const timestampUtc = now.toISOString();

  const activeRoutes = ROUTES.map(r => ({ ...r, destAddress: process.env[r.destEnv] }))
    .filter(r => {
      if (!r.destAddress) {
        console.log(`Skipping ${r.id}: ${r.destEnv} is not set yet.`);
        return false;
      }
      return true;
    });

  if (activeRoutes.length === 0) {
    console.error('No routes have both ORIGIN_ADDRESS and a destination secret set. Nothing to do.');
    process.exitCode = 1;
    return;
  }

  const records = loadExistingData();
  let anyRoutesParsed = false;
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    headless: true,
  });

  try {
    for (const route of activeRoutes) {
      const origin = beforeMidday ? ORIGIN_ADDRESS : route.destAddress;
      const destination = beforeMidday ? route.destAddress : ORIGIN_ADDRESS;
      const originLabel = beforeMidday ? ORIGIN_LABEL : route.destLabel;
      const destLabel = beforeMidday ? route.destLabel : ORIGIN_LABEL;

      console.log(`[${route.id}] ${originLabel} -> ${destLabel} (${direction})`);

      let routes;
      try {
        routes = await scrapeRoutes(browser, origin, destination);
      } catch (err) {
        console.error(`[${route.id}] Failed to scrape:`, err.message);
        continue;
      }

      console.log(`[${route.id}] Parsed routes:`, JSON.stringify(routes, null, 2));

      if (routes.length === 0) {
        console.error(`[${route.id}] No routes parsed from the page.`);
        continue;
      }
      anyRoutesParsed = true;

      routes.forEach((route_, i) => {
        records.push({
          route_id: route.id,
          timestamp_utc: timestampUtc,
          date_brisbane: dateStr,
          time_brisbane: timeBrisbane,
          direction,
          origin_label: originLabel,
          dest_label: destLabel,
          route_index: i + 1,
          duration_minutes: route_.duration_minutes,
          duration_text: route_.duration_text,
          distance_text: route_.distance_text,
          via: route_.via,
        });
      });
    }
  } finally {
    await browser.close();
  }

  saveData(records);
  console.log(`Total records: ${records.length}`);

  if (!anyRoutesParsed) {
    console.error('No route parsed successfully across any active route pair. Failing so this run is visible in the Actions log.');
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
