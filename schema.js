// Infers typed grid columns from DuckDB's own schema (`DESCRIBE`), and finds
// a position (lon/lat or geometry) plus a default numeric/categorical pair
// for the KPI strip and chart, so the page never hard-codes a dataset's
// shape — any dropped file gets the same treatment as the sample.
const NUMBER = /INT|DECIMAL|DOUBLE|FLOAT|REAL|NUMERIC|HUGEINT/;
const LON = /^(lon|lng|longitude)$/i;
const LAT = /^(lat|latitude)$/i;
const GEOM = /^(geom|geometry|wkb_geometry)$/i;

/**
 * @param {object} connection a DuckDB-WASM connection (`query` required)
 * @param {string} from the FROM expression the adapter will also use
 * @returns {Promise<{columns: object[], rowKey: string, numericField: string|null,
 *   categoryField: string|null, position: object|null}>}
 */
export async function inspectSchema(connection, from) {
  const result = await connection.query(`DESCRIBE SELECT * FROM ${from}`);
  const rows = result.toArray ? result.toArray() : await result.getRowObjects();

  const columns = [];
  let rowKey = null, numericField = null, categoryField = null, lon = null, lat = null, geom = null;
  for (const raw of rows) {
    const name = String(raw.column_name);
    const type = String(raw.column_type).toUpperCase();
    const col = { field: name, title: name };
    if (/BOOL/.test(type)) col.type = 'boolean';
    else if (/^TIMESTAMP/.test(type)) col.type = 'datetime';
    else if (type === 'DATE') col.type = 'date';
    else if (NUMBER.test(type)) col.type = 'number';
    columns.push(col);

    const looksLikeId = /(^id$|_id$)/i.test(name);
    if (!rowKey && looksLikeId) rowKey = name;
    if (!numericField && col.type === 'number' && !looksLikeId) numericField = name;
    if (!categoryField && !col.type && !LON.test(name) && !LAT.test(name)) categoryField = name;
    if (LON.test(name)) lon = name;
    if (LAT.test(name)) lat = name;
    if (GEOM.test(name) || type === 'GEOMETRY') geom = name;
  }
  if (!rowKey) rowKey = columns[0].field;
  const position = geom ? { geometry: geom } : (lon && lat ? { lon, lat } : null);
  return { columns, rowKey, numericField, categoryField, position };
}
