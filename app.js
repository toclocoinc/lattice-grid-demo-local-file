// Wiring only. The engine lives in engine.js, schema inference in schema.js,
// the KPI/chart/map/statistics panels in viewers.js. Findings are listed in
// README.md.
//
// Two ways in: drop (or choose) a file — registered with DuckDB-WASM via
// registerFileHandle, read lazily, never uploaded — or load the sample, the
// one deliberate network fetch on the page. Either way the grid sits on
// duckdbAdapter + createPushdownSource, so every filter, sort and aggregate
// after that runs in DuckDB, not in this file.
import { startEngine, registerDropped, registerSample } from './engine.js?v=20261003a-1630';
import { inspectSchema } from './schema.js?v=20261003a-1630';
import { mountViewers } from './viewers.js?v=20261003a-1630';
import { registerBundled, exposeData, runSql, mountPivot } from './sql.js?v=20261003a-1630';

const SAMPLE_URL = 'https://data.latticegrid.dev/samples/transactions-10m.parquet';
const el = (id) => document.getElementById(id);
const { createGrid, createPushdownSource, duckdbAdapter } = LatticeGrid;

const els = {
  kpi: el('kpi'), chart: el('chart'), stats: el('stats'),
  mapPanel: el('map-panel'), map: el('map'), layout: el('layout'),
};
el('version').textContent = LatticeGrid.getVersion ? LatticeGrid.getVersion() : '';

let engine = null;
let viewers = null;
let grid = null;
let sinceOpenBase = 0;

// Live "bytes sent" readout: every Resource Timing entry created since the
// current file was opened, summed — excluding the library's own static
// assets (the CDN bundle and map tiles), which are fetched from hosts that
// were never told the file exists and cannot be carrying it. A dropped file
// issues no *other* request at all, so this stays at 0 for it; the sample
// shows its one deliberate fetch, labelled.
const STATIC_ASSET = /cdn\.jsdelivr\.net|tile\.openstreetmap\.org/;
let openedAt = performance.now();
const bytesEl = el('bytes');
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.startTime >= openedAt && !STATIC_ASSET.test(entry.name)) sinceOpenBase += entry.transferSize || 0;
  }
  bytesEl.textContent = `Bytes sent since this file was opened: ${sinceOpenBase.toLocaleString()}`;
}).observe({ type: 'resource', buffered: true });

const status = (text) => { el('status').textContent = text; el('loading-text').textContent = text; };
const showDropzone = (show) => { el('dropzone').hidden = !show; };

/** Show the exact SQL (with bound values) of the last query DuckDB ran. */
function showLastSql() { el('sql').textContent = engine.lastSql() || '—'; }

/**
 * Open a new relation (a dropped file's FROM expression, or the sample's)
 * and rebuild the grid and its viewers over it.
 * @param {string} from the DuckDB FROM expression
 * @param {string} label shown in the status line
 * @param {boolean} [asResult] a SQL result: pivot replaces the map, row count is DuckDB's
 */
async function openRelation(from, label, asResult = false) {
  // Cleared up front, not just set at the end: a probe (or a second click)
  // reading `window.__demo` while this is still in flight must see that the
  // previous relation is gone, not the stale one.
  window.__demo = null;
  status(`Reading ${label}'s schema…`);
  const meta = await inspectSchema(engine.connection, from);
  const t0 = performance.now();

  const adapter = duckdbAdapter({ connection: engine.connection, from });
  const source = createPushdownSource({ adapter, pageSize: 100, aggregates: { default: 'engine' } });
  // Viewers first: destroying a grid while a KPI/chart/map still bound to it
  // is alive throws from a timer (F-0728-2), so tear down what is bound to
  // the grid before the grid itself.
  if (viewers) viewers.destroy();
  if (grid) grid.destroy();
  el('grid').textContent = '';
  grid = createGrid(el('grid'), {
    rowKey: meta.rowKey, source, columns: meta.columns, selection: 'single',
    toolPanel: { panels: ['columns', 'filters', 'quick'] },
  });
  grid.on('filter:changed', showLastSql);
  grid.on('sort:changed', showLastSql);
  grid.on('model:changed', showLastSql);

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (grid.rows.count() > 0) { clearInterval(timer); resolve(); }
    }, 50);
  });
  const firstRowsMs = Math.round(performance.now() - t0);
  showLastSql();
  viewers = mountViewers(grid, asResult ? { ...meta, position: null } : meta, els);
  el('pivot-panel').hidden = true;
  if (asResult) {
    els.layout.classList.remove('no-map');
    const pivot = mountPivot(meta, createGrid, createPushdownSource({ adapter, pageSize: 100, aggregates: { default: 'engine' } }));
    const kill = viewers.destroy;
    viewers.destroy = () => { pivot.destroy(); kill(); };
  }
  status(`${label}: first rows in ${firstRowsMs} ms.`);
  window.__demo = { grid, source, engine, meta, viewers, timings: { firstRowsMs } };
}

/** A file was dropped or chosen: opened with no network request at all. */
async function openFile(file) {
  showDropzone(false);
  status(`Registering "${file.name}" with DuckDB-WASM (registerFileHandle, read lazily)…`);
  try {
    if (!engine) engine = await startEngine();
    // Reset AFTER the engine's own one-time bundle download, not before: that
    // download is the engine's runtime, not the file, and must never be
    // counted into "bytes sent since this file was opened".
    openedAt = performance.now();
    sinceOpenBase = 0;
    const { from } = await registerDropped(engine, file);
    await openRelation(from, file.name);
    await exposeData(engine, from, false);
  } catch (error) {
    console.error('[local-file demo] openFile', error);
    status(`Failed to open "${file.name}": ${error.message}`);
    showDropzone(true);
  }
}

/** The one deliberate network fetch on the page. */
async function loadSample() {
  showDropzone(false);
  try {
    if (!engine) engine = await startEngine();
    // See openFile(): reset after the engine's own bundle download, so the
    // readout shows only the one labelled sample fetch, not the runtime too.
    openedAt = performance.now();
    sinceOpenBase = 0;
    status('Fetching the 89 MB sample — the one network request this page makes…');
    const { from, bytes } = await registerSample(engine, SAMPLE_URL,
      (loaded, total) => status(`Fetching the sample: ${(loaded / 1e6).toFixed(1)} MB${total ? ` of ${(total / 1e6).toFixed(1)} MB` : ''}…`));
    await openRelation(from, `the sample (${(bytes / 1e6).toFixed(1)} MB fetched)`);
    await exposeData(engine, from, false);
  } catch (error) {
    console.error('[local-file demo] loadSample', error);
    status(`Failed to load the sample: ${error.message}`);
    showDropzone(true);
  }
}

/** The bundled public sample (Palmer penguins, CC0): same-origin, no external request. */
async function loadBundled() {
  showDropzone(false);
  try {
    if (!engine) engine = await startEngine();
    openedAt = performance.now();
    sinceOpenBase = 0;
    const { from } = await registerBundled(engine);
    await openRelation(from, 'penguins.csv (bundled sample)');
    await exposeData(engine, from, true);
    await runQuery();
  } catch (error) {
    console.error('[local-file demo] loadBundled', error);
    status(`Failed to load the bundled sample: ${error.message}`);
  }
}

/** Run the SQL box; the grid, chart, statistics and pivot then show the result. */
async function runQuery() {
  const done = await runSql(engine);
  if (!done) { status('The query failed — DuckDB\'s message is under the SQL box.'); return; }
  await openRelation('result', `SQL result (${done.rows.toLocaleString()} rows, counted by DuckDB)`, true);
  window.__demo.duckdbRows = done.rows;
}
el('sql-run').addEventListener('click', runQuery);
el('bundled').addEventListener('click', loadBundled);

for (const zone of [document.body, el('dropzone')]) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); el('dropzone').hidden = false; el('dropzone').classList.add('drag'); });
  zone.addEventListener('dragleave', () => el('dropzone').classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    el('dropzone').classList.remove('drag');
    const file = e.dataTransfer.files[0];
    if (file) openFile(file);
  });
}
for (const id of ['pick', 'pick2']) el(id).addEventListener('click', () => el('file-input').click());
el('file-input').addEventListener('change', (e) => { if (e.target.files[0]) openFile(e.target.files[0]); });
for (const id of ['sample', 'sample2']) el(id).addEventListener('click', loadSample);
