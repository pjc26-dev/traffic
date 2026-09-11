# Pallara travel time monitor

Scrapes Google Maps' three suggested driving routes between a point in
**Pallara** and up to four separate destinations, every 10 minutes,
7am&ndash;7pm Australia/Brisbane time, on 11 weekdays (11&ndash;25 Sep 2026).
Every route pair shares the same schedule:

- Before midday: Pallara &rarr; destination
- From midday: destination &rarr; Pallara

The exact street addresses are kept out of this repo entirely (see **Setup
required** below) so they're never visible in source, logs, or the
dashboard &mdash; only suburb/generic route labels and the resulting travel
times are public. Destinations 2&ndash;4 use generic labels ("Destination
2", etc.) rather than real place names, by request &mdash; **do not add
real place names for these anywhere in this repo** (code, comments, commit
messages); they only ever belong in the GitHub secret values below.

## How it works

- `.github/workflows/collect.yml` runs on a GitHub Actions schedule roughly
  every 10 minutes. `scripts/collect.mjs` checks the current Brisbane time;
  outside the monitored dates/hours it exits immediately. When in-window, it
  loops over every route pair that has both secrets set, drives headless
  Chromium (Playwright) to Google Maps' directions page for each, and parses
  the three suggested routes' durations. Route pairs whose destination
  secret isn't set yet are skipped (logged, not a failure), so adding a new
  one later just requires adding its secret &mdash; no code change. Results
  are appended to `data/readings.json`, tagged with a `route_id`; new data
  is committed back to the repo and the dashboard redeployed to GitHub Pages
  in the same job.
- `site/index.html` is the dashboard: a route selector, a heatmap of the
  fastest route by day and time, a per-day chart of all three routes, and a
  raw data table &mdash; all filtered to the selected route pair.

No Google Maps API key/billing was available, so this scrapes the public
Maps UI rather than calling the Directions API &mdash; the DOM parsing in
`scripts/collect.mjs` may need small adjustments if Google changes their
markup. If a run finds zero routes, re-run it manually (see **Manual
testing**) with debug output enabled to see what the parser saw.

## Setup required

1. **Repository secrets** (Settings &rarr; Secrets and variables &rarr;
   Actions &rarr; New repository secret):
   - `ORIGIN_ADDRESS` &mdash; the full Pallara address to query (shared by
     every route pair). Required &mdash; the workflow won't run without it.
   - `DEST_ADDRESS` &mdash; destination for route 1 (currently Eight Mile
     Plains). Required for route 1 to collect.
   - `DEST_ADDRESS_2`, `DEST_ADDRESS_3`, `DEST_ADDRESS_4` &mdash; optional,
     one per additional route pair. Each can be a full address or just a
     place name Google Maps can resolve (e.g. `"Some Station, QLD,
     Australia"`). A route pair with no destination secret set is simply
     skipped until you add one.
2. **GitHub Pages**, once: **Settings &rarr; Pages &rarr; Build and
   deployment &rarr; Source: GitHub Actions**. After that, the dashboard
   auto-publishes on every run that collects new data.

## Manual testing

Trigger `.github/workflows/collect.yml` via "Run workflow": `force: true`
scrapes immediately regardless of date/time gating; `debug: true` also dumps
each scraped page's text to the run log (off by default since it echoes the
input street names) &mdash; useful together when checking the scraper still
parses Google Maps' current markup.
