# Pallara &harr; Eight Mile Plains travel time monitor

Scrapes Google Maps' three suggested driving routes between a point in
**Pallara** and a point in **Eight Mile Plains**, every 10 minutes,
7am&ndash;7pm Australia/Brisbane time, on 11 weekdays (11&ndash;25 Sep 2026).

- Before midday: Pallara &rarr; Eight Mile Plains
- From midday: Eight Mile Plains &rarr; Pallara

The exact street addresses are kept out of this repo (see **Setup required**
below) so they're never visible in source, logs, or the dashboard - only the
suburb names and the resulting travel times are public.

## How it works

- `.github/workflows/collect.yml` runs on a GitHub Actions schedule roughly
  every 10 minutes. `scripts/collect.mjs` checks the current Brisbane time;
  outside the monitored dates/hours it exits immediately. When in-window, it
  drives headless Chromium (Playwright) to Google Maps' directions page,
  parses the three suggested routes' durations, and appends them to
  `data/readings.json`. New data is committed back to the repo and the
  dashboard is redeployed to GitHub Pages in the same job.
- `site/index.html` is the dashboard: a heatmap of the fastest route by day
  and time, a per-day chart of all three routes, and a raw data table.

No Google Maps API key/billing was available, so this scrapes the public
Maps UI rather than calling the Directions API &mdash; the DOM parsing in
`scripts/collect.mjs` may need small adjustments if Google changes their
markup. If a run finds zero routes, re-run it manually (see **Manual
testing**) with debug output enabled to see what the parser saw.

## Setup required

1. **Repository secrets** (Settings &rarr; Secrets and variables &rarr;
   Actions &rarr; New repository secret) &mdash; required, the workflow
   won't run without them:
   - `ORIGIN_ADDRESS` &mdash; the full Pallara address to query
   - `DEST_ADDRESS` &mdash; the full Eight Mile Plains address to query
2. **GitHub Pages**, once: **Settings &rarr; Pages &rarr; Build and
   deployment &rarr; Source: GitHub Actions**. After that, the dashboard
   auto-publishes on every run that collects new data.

## Manual testing

Trigger `.github/workflows/collect.yml` via "Run workflow": `force: true`
scrapes immediately regardless of date/time gating; `debug: true` also dumps
the scraped page text to the run log (off by default since it echoes the
input street names) &mdash; useful together when checking the scraper still
parses Google Maps' current markup.
