// One DuckDB-WASM engine (1.32.0, DuckDB 1.4) for both a dropped file and the
// fetched sample. A dropped file never leaves the File API: DuckDB reads it
// lazily through registerFileHandle, which streams byte ranges via
// FileReader as queries need them, rather than the page or DuckDB ever
// holding the whole thing as one buffer. The sample is the one deliberate
// network fetch on the page; once downloaded it is registered as a buffer,
// so every query after that is local too, exactly like the dropped path.
const VERSION = '1.32.0';

/**
 * Start DuckDB-WASM and wrap its connection so the page can show the exact
 * SQL (bound values interpolated for display only) of the last statement
 * the grid's adapter ran.
 * @returns {Promise<{db: object, connection: object, protocol: object, lastSql: () => string}>}
 */
export async function startEngine() {
  const duckdb = await import(`https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${VERSION}/+esm`);
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const worker = await duckdb.createWorker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const raw = await db.connect();

  let last = '';
  const display = (sql, params) => (params.length
    ? sql.replace(/\?/g, () => JSON.stringify(params.shift()))
    : sql);
  const connection = {
    query: (sql) => { last = sql; return raw.query(sql); },
    prepare: async (sql) => {
      const statement = await raw.prepare(sql);
      return {
        query: (...params) => { last = display(sql, params.slice()); return statement.query(...params); },
        close: () => statement.close(),
      };
    },
  };
  return { db, connection, protocol: duckdb.DuckDBDataProtocol, lastSql: () => last };
}

/**
 * Register a dropped File with DuckDB-WASM via `registerFileHandle`, so it
 * is read lazily in byte ranges as queries need it — never copied into a JS
 * array or an ArrayBuffer the page holds. CSV/TSV/JSON/NDJSON go through
 * DuckDB's own readers over the same handle.
 * @param {{db: object, protocol: object}} engine from startEngine()
 * @param {File} file the dropped or chosen file
 * @returns {Promise<{from: string}>}
 */
export async function registerDropped(engine, file) {
  const name = 'dropped-' + Date.now();
  await engine.db.registerFileHandle(name, file, engine.protocol.BROWSER_FILEREADER, true);
  return { from: fromFor(file.name, name) };
}

/**
 * Fetch the sample Parquet — the one labelled network request on the page —
 * and register the result as a buffer, so every query after it is local.
 * @param {{db: object}} engine from startEngine()
 * @param {string} url the sample's URL
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @returns {Promise<{from: string, bytes: number}>}
 */
export async function registerSample(engine, url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sample fetch failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }
  const buffer = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) { buffer.set(chunk, at); at += chunk.length; }
  const name = 'sample.parquet';
  await engine.db.registerFileBuffer(name, buffer);
  return { from: `read_parquet('${name}')`, bytes: loaded };
}

/**
 * The DuckDB FROM expression for a registered file, by its original
 * extension.
 * @param {string} filename the dropped file's name
 * @param {string} name the name it was registered under
 * @returns {string} a FROM expression
 */
function fromFor(filename, name) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'parquet') return `read_parquet('${name}')`;
  if (ext === 'tsv') return `read_csv_auto('${name}', delim='\t')`;
  if (ext === 'csv') return `read_csv_auto('${name}')`;
  if (ext === 'ndjson' || ext === 'jsonl') return `read_ndjson_auto('${name}')`;
  if (ext === 'json') return `read_json_auto('${name}')`;
  throw new Error(`unrecognised file type: .${ext} (use .parquet, .csv, .tsv, .json or .ndjson)`);
}
