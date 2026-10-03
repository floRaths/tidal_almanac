const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('docs/main.js', 'utf8');
const fixture = JSON.parse(fs.readFileSync('docs/data/tides-2026.json', 'utf8'));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

function createApp({ hostname = 'localhost', apiBaseUrl = '', fetch }) {
  const elements = new Map();
  for (const id of ['stationSelect', 'yearInput', 'loadButton', 'retryButton', 'loadStatus', 'monthSelect', 'daytimeControl', 'chart', 'chartTitle', 'chartSubhead', 'stationLabel', 'yearLabel', 'eventLabel', 'meanHeight', 'ampRange']) {
    elements.set(id, {
      innerHTML: '', textContent: '', value: '', disabled: id === 'stationSelect', hidden: false,
      dataset: {}, attributes: {}, listeners: {}, selectedOptions: [{ textContent: 'Santa Monica' }],
      addEventListener(name, callback) { this.listeners[name] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelectorAll() { return []; },
      reportValidity() { return Number.isInteger(Number(this.value)) && Number(this.value) >= 1900 && Number(this.value) <= 2100; },
    });
  }
  const context = vm.createContext({
    document: { querySelector: (selector) => elements.get(selector.slice(1)) },
    location: { hostname }, window: { TIDAL_CONFIG: { apiBaseUrl } },
    fetch, AbortController, setTimeout, clearTimeout, Date, Intl, TypeError, SyntaxError, console,
  });
  vm.runInContext(source, context);
  return { context, elements, run: (code) => vm.runInContext(code, context) };
}
const ok = (data) => ({ ok: true, json: async () => data });

(async () => {
  const requests = [];
  let fail = false;
  const app = createApp({ fetch: async (url) => {
    requests.push(url);
    if (url.endsWith('/api/stations')) return ok({ stations: [fixture.station], min_year: 1900, max_year: 2100 });
    if (fail) return { ok: false, json: async () => ({ error: 'NOAA unavailable' }) };
    const year = Number(new URL(url, 'http://localhost').searchParams.get('year'));
    return ok({ ...fixture, year });
  }});
  await flush();
  assert.match(app.elements.get('chart').innerHTML, /calendar-svg/);
  assert.equal(app.elements.get('stationSelect').disabled, false);
  const initialRequests = requests.length;
  await app.run('loadCalendar()');
  assert.equal(requests.length, initialRequests, 'same selection is cached in the tab');
  app.elements.get('yearInput').value = '2027';
  await app.run('loadCalendar()');
  assert.equal(app.elements.get('yearLabel').textContent, 2027);
  fail = true;
  app.elements.get('yearInput').value = '2028';
  await app.run('loadCalendar()');
  assert.equal(app.elements.get('yearLabel').textContent, 2027, 'failed request keeps the previous calendar');
  assert.equal(app.elements.get('retryButton').hidden, false);
  assert.match(app.elements.get('loadStatus').textContent, /NOAA unavailable/);
  fail = false;
  await app.elements.get('retryButton').listeners.click();
  assert.equal(app.elements.get('yearLabel').textContent, 2028);
  assert.equal(app.elements.get('retryButton').hidden, true);
  app.run('state.month = 12; render()');
  const boundary = [
    { ...fixture.records[0], week: 52, day: 28, month: 12 },
    { ...fixture.records[0], week: 1, day: 31, month: 12 },
  ];
  app.context.boundary = boundary;
  app.run('renderSvg(boundary, "December", "Sunrise")');
  const svg = app.elements.get('chart').innerHTML;
  assert.ok(svg.indexOf('>52</text>') < svg.indexOf('>1</text>'), 'ISO week rows stay chronological');

  const saved = createApp({ hostname: 'floraths.github.io', fetch: async (url) => {
    assert.equal(url, 'data/tides-2026.json');
    return ok(fixture);
  }});
  await flush();
  assert.equal(saved.elements.get('yearInput').disabled, true);
  assert.equal(saved.elements.get('loadButton').disabled, true);
  assert.match(saved.elements.get('loadStatus').textContent, /saved 2026 calendar/);
  assert.match(saved.elements.get('chart').innerHTML, /calendar-svg/);

  let retry = false;
  const unavailable = createApp({ apiBaseUrl: 'https://calendar.example', fetch: async () => {
    if (!retry) throw new TypeError('Network unavailable');
    return ok({ stations: [fixture.station], min_year: 1900, max_year: 2100 });
  }});
  await flush();
  assert.equal(unavailable.elements.get('retryButton').hidden, false);
  assert.match(unavailable.elements.get('loadStatus').textContent, /Could not reach/);
  assert.equal(unavailable.elements.get('loadButton').disabled, true);
  console.log('Frontend checks passed: loading, selection, caching, failure/retry, saved fallback, ISO week ordering.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
