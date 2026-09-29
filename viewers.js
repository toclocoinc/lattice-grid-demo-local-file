// Builds the KPI strip, chart, map and statistics panel around a grid.
// Every number here is computed by DuckDB (GEO-5/GEO-6 pushdown): the KPI
// sum/avg, the chart's bars and the map's viewport all ask
// `source.aggregate()` rather than reducing whatever page is loaded.
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * @param {object} grid the grid
 * @param {{numericField: string|null, categoryField: string|null, position: object|null}} meta from schema.js
 * @param {{kpi: Element, chart: Element, stats: Element, mapPanel: Element, map: Element, layout: Element}} els
 * @returns {{destroy: () => void}}
 */
export function mountViewers(grid, meta, els) {
  const { numericField, categoryField, position } = meta;
  const teardown = [];

  const kpi = LatticeGridKPI.createKPI(els.kpi, {
    grid, columns: 3,
    tiles: [
      { id: 'rows', label: 'Rows (current filter)', aggregation: 'count' },
      ...(numericField ? [
        { id: 'sum', label: `Sum of ${numericField}`, aggregation: 'sum', field: numericField, format: { decimals: 2 } },
        { id: 'avg', label: `Average ${numericField}`, aggregation: 'avg', field: numericField, format: { decimals: 2 } },
      ] : []),
    ],
  });
  teardown.push(() => kpi.destroy());

  els.chart.textContent = '';
  if (numericField && categoryField) {
    const chart = LatticeGrid.createChart({
      grid, container: els.chart, type: 'bar', x: categoryField, y: numericField,
      title: `Sum of ${numericField} by ${categoryField} (computed by DuckDB)`,
    });
    teardown.push(() => chart.destroy());
  } else {
    els.chart.textContent = 'No categorical + numeric column pair to chart.';
  }

  const stats = LatticeGrid.mountPanel({ grid, panel: 'statistics', container: els.stats });
  teardown.push(() => stats.destroy());

  els.mapPanel.hidden = !position;
  els.layout.classList.toggle('no-map', !position);
  if (position) {
    els.map.innerHTML = '';
    const leafletMap = L.map(els.map).setView([20, 0], 2);
    L.tileLayer(TILE_URL, { attribution: '&copy; OpenStreetMap contributors', maxZoom: 18 }).addTo(leafletMap);
    const binding = LatticeGridLeaflet.bindLeaflet(grid, {
      map: leafletMap,
      position,
      layers: (rows, ctx) => [L.geoJSON(ctx.features, {
        pointToLayer: (feature, at) => L.circleMarker(at, { radius: 3, weight: 0, fillOpacity: .7 }),
      })],
      viewportFilter: false,
    });
    teardown.push(() => { binding.destroy(); leafletMap.remove(); });
  }

  return { kpi, destroy: () => teardown.forEach((fn) => fn()) };
}
