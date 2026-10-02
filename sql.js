// The SQL box: the opened file is exposed to the user as the view `data`; a
// query runs in DuckDB-WASM into the table `result`, which the grid, chart,
// statistics panel and pivot then all read. Nothing leaves the tab.
const el = (id) => document.getElementById(id);
const DEFAULT_SQL = 'SELECT * FROM data LIMIT 1000';
const PENGUIN_SQL = `SELECT species, island, count(*) AS n, round(avg(body_mass_g), 1) AS avg_mass
FROM data GROUP BY species, island ORDER BY n DESC`;

/**
 * Register the bundled public sample (same-origin, 15 KB) with DuckDB.
 * @param {{db: object}} engine from startEngine()
 * @returns {Promise<{from: string}>}
 */
export async function registerBundled(engine) {
  const res = await fetch('penguins.csv');
  if (!res.ok) throw new Error(`bundled sample failed: HTTP ${res.status}`);
  await engine.db.registerFileBuffer('penguins.csv', new Uint8Array(await res.arrayBuffer()));
  return { from: "read_csv_auto('penguins.csv', nullstr='NA')" };
}

/**
 * Expose the opened relation as `data` and pre-fill the SQL box.
 * @param {{connection: object}} engine
 * @param {string} from the FROM expression of the opened file
 * @param {boolean} penguins whether it is the bundled sample
 */
export async function exposeData(engine, from, penguins) {
  await engine.connection.query(`CREATE OR REPLACE VIEW data AS SELECT * FROM ${from}`);
  el('sql-text').value = penguins ? PENGUIN_SQL : DEFAULT_SQL;
  el('sql-box').hidden = false;
  el('sql-error').textContent = '';
}

/**
 * Run the user's SQL into `result`. A DuckDB error is shown in the page and
 * leaves the previous result in place.
 * @param {{connection: object}} engine
 * @returns {Promise<{rows: number}|null>} the DuckDB row count, or null on error
 */
export async function runSql(engine) {
  const sql = el('sql-text').value.trim().replace(/;+\s*$/, '');
  try {
    await engine.connection.query(`DESCRIBE ${sql}`); // the error then quotes the user's own SQL, not the wrapper
    await engine.connection.query(`CREATE OR REPLACE TABLE result AS SELECT *, row_number() OVER () AS row_id FROM (${sql})`);
    const count = await engine.connection.query('SELECT count(*) AS n FROM result');
    el('sql-error').textContent = '';
    return { rows: Number(count.toArray()[0].n) };
  } catch (error) {
    el('sql-error').textContent = error.message;
    return null;
  }
}

/**
 * Mount the pivot of the result: first text column down, second across, the
 * measure summed — a second grid on the same DuckDB table, pivoted in the engine.
 * @param {object} meta from inspectSchema()
 * @param {Function} createGrid
 * @param {object} source a pushdown source over `result`
 * @returns {{destroy: () => void}}
 */
export function mountPivot(meta, createGrid, source) {
  const host = el('pivot');
  host.textContent = '';
  el('pivot-panel').hidden = false;
  const text = meta.columns.filter((c) => !c.type && c.field !== 'row_id');
  if (text.length < 2 || !meta.numericField) {
    host.textContent = 'A pivot needs two text columns and a number in the result.';
    return { destroy() {} };
  }
  const grid = createGrid(host, {
    rowKey: meta.rowKey, source,
    columns: meta.columns.map((c) => (c.field === text[0].field ? { ...c, group: { enabled: true } }
      : c.field === text[1].field ? { ...c, pivot: { enabled: true } }
      : c.field === meta.numericField ? { ...c, total: 'sum' } : c)),
  });
  return { destroy: () => grid.destroy() };
}
