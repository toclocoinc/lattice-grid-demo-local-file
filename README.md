# Your file never leaves the browser

A [Lattice Grid](https://www.latticegrid.dev) demo: drop a Parquet, CSV, TSV or
NDJSON file (or load the sample) and the grid, its KPI strip, chart, map and
statistics panel all run against it — entirely inside DuckDB-WASM, in a Web
Worker in this tab. Nothing is uploaded. Closing the tab discards the data.

Live: https://toclocoinc.github.io/lattice-grid-demo-local-file/

## SQL on your own file

Open a file (or press **Try the small sample**) and a SQL box appears: your file
is the table `data`. Run any DuckDB `SELECT`; the result lands in a DuckDB table
and the grid, KPI strip, chart, statistics (profile) panel and a **pivot**
(first text column down, second across, the first number summed) all read that
result. The row count in the status line is DuckDB's own `count(*)` of the
result. A SQL error is shown in the page as DuckDB's message and leaves the
previous result in place. Nothing is uploaded and nothing is requested after
the page and DuckDB have loaded: in headless Chrome (net-log), after DuckDB was
up, a drop, three queries and an invalid query made **0** requests. Caveat: a
file with `lat`/`lon` columns shows the map when opened directly, and the map
fetches OpenStreetMap tiles (coordinates of the viewport, not your data); a SQL
result shows the pivot in the map's place, so SQL results make no tile requests.

## What it proves

- **A dropped file is registered with DuckDB-WASM via `registerFileHandle`**,
  never read into a JS array or an `ArrayBuffer` the page holds. DuckDB reads
  it lazily, in byte ranges, as a query needs them (Parquet), or streams it
  through its own CSV/JSON readers over the same handle.
- **The grid sits on `duckdbAdapter` + `createPushdownSource`.** Every
  filter, sort and aggregate — the KPI sum/avg, the chart's bars, the
  statistics panel's subset-vs-population figures, the map's viewport rows —
  is pushed into DuckDB as SQL. The last statement DuckDB ran (with its bound
  values shown, for readability) sits beside the grid.
- **The "Bytes sent since this file was opened" readout** is built from the
  [Resource Timing API](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Resource_timing),
  summing every network request since the file was opened (excluding the
  library's own static assets — the CDN bundle and map tiles — which are
  fetched from hosts that were never told the file exists). For a dropped
  file it never leaves 0, because no request is ever made for it. Open
  DevTools → Network and filter or sort the grid: nothing appears.
- **"Load the sample"** fetches the 89 MB `transactions-10m.parquet` from
  `https://data.latticegrid.dev/samples/transactions-10m.parquet` — the one
  deliberate, labelled network request on the page. Once downloaded it is
  registered as a buffer, so every query after that is local too, exactly
  like the dropped path.

## Browser requirements

WebAssembly, and a 64-bit browser: DuckDB-WASM needs more than 4 GB of
addressable memory to hold a large file's working set. Recent Chrome,
Firefox, Safari and Edge on desktop all qualify; DuckDB-WASM ships an `eh`
(exception-handling) build and falls back automatically where that is
unsupported.

## Timings (headless Chrome, `docs/CHECKS.md` numbers below)

Measured against a local build of the exact same page (the sample served
from `localhost` rather than the CDN, so these are a lower bound on real
network latency for that one fetch — everything after the fetch is
identical):

| Check | Result |
|---|---|
| Sample (10M rows): first rows, cold | 1.66 s |
| Sample: a filter (`category = 'food'`) | 389 ms |
| Sample: a sort (`amount desc`) | 776 ms |
| Dropped 1M-row Parquet: first rows | 9.9 s (lazy `registerFileHandle` reads trade speed for never copying the file) |
| Dropped 1M-row Parquet: a filter | 1.1 s |
| Dropped ~200 MB CSV: first rows | 1.1 s |
| Network requests during the dropped-file filter/sort | **0** |
| Console errors | **0** |

The 200 MB CSV and the 1M-row Parquet used for these checks are generated
locally with DuckDB and never committed (see "Reproducing the checks"
below). The 10M-row sample is real production data for this demo, generated
once and hosted on `data.latticegrid.dev`.

## Reproducing the checks

The test fixtures above are not committed (a 1M-row Parquet and a ~200 MB
CSV would bloat this repo for no benefit — anyone can regenerate them). With
DuckDB available in Node (`npm install --no-save @duckdb/node-api`):

```sql
-- a 1M-row Parquet with lon/lat, to exercise the map path
SELECT setseed(0.42);
COPY (
  SELECT i AS id, TIMESTAMP '2026-01-01' + INTERVAL (i) SECOND AS ts,
    ['transfer','payment','refund','fee','deposit'][(i % 5) + 1] AS category,
    round(5 + random() * 995, 2) AS amount, (i % 37) + 1 AS qty,
    round(-90 + random() * 180, 5) AS lat, round(-180 + random() * 360, 5) AS lon
  FROM range(1000000) t(i)
) TO 'test-1m.parquet' (FORMAT PARQUET);
```

Drop the result onto the live page in a real or headless browser and drive
`window.LatticeGrid`/the grid instance the page exposes at `window.__demo`
through its `filters`, `sort` and KPI APIs to reproduce the numbers above.

## Data & licences

- **Bundled small sample** (`penguins.csv`, 344 rows): the Palmer Penguins
  data by Allison Horst, Alison Hill and Kristen Gorman, from
  [allisonhorst/palmerpenguins](https://github.com/allisonhorst/palmerpenguins)
  (`inst/extdata/penguins.csv`), licence **CC0 1.0** (public domain dedication).
  Served from this repository, same origin; missing values are `NA`.

- **Sample data** (`transactions-10m.parquet`): synthetic transactions
  generated for this demo by TOCLOCO Inc. No personal data; no external
  licence applies.
- **Map tiles**: [OpenStreetMap](https://www.openstreetmap.org/copyright)
  raster tiles via `tile.openstreetmap.org`, used within OSM's tile usage
  policy for a low-traffic public demo.
- **Lattice Grid**: loaded from the published CDN build
  (`@toclocoinc/lattice-grid`), unwatermarked under a domain-locked demo
  licence bound to `toclocoinc.github.io`.
- **Leaflet**: loaded from jsDelivr, BSD-2-Clause.

## Demo code licence

MIT — see [LICENSE](LICENSE). This covers the files in this repository
(`index.html`, `app.js`, `engine.js`, `schema.js`, `sql.js`, `viewers.js`); it does not
relicense Lattice Grid itself, which is loaded from the CDN under its own
commercial licence.

## Known limitations / findings

- `grid.rows.matchCount()` briefly reports the size of the loaded window
  rather than the true filtered total immediately after a filter or sort on
  a large pushdown source, until the engine's own deferred total settles
  (documented behaviour, not a defect — see `docs/api/grid.html#duckdb-total`
  in the Lattice Grid source). A host reading the total right after
  `filters.set()` should wait for `model:changed` rather than reading it
  synchronously.
- Destroying a grid before destroying viewers still bound to it (a KPI
  panel, a chart, a map binding) can throw from a timer — a known issue
  (F-0728-2 in the Lattice Grid backlog). This page's own `openRelation()`
  destroys its viewers *before* the grid it is about to replace, specifically
  to avoid it.
- `list`/`struct`-typed Parquet columns and DuckDB's own `GEOMETRY` type were
  not exercised by this demo's own test fixtures; a file with those column
  types is untested here.
