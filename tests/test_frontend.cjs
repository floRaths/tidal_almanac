const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('docs/main.js', 'utf8');
const fixture = JSON.parse(fs.readFileSync('docs/data/tides-2026.json', 'utf8'));
const otherStation = { ...fixture.station, id: '9410230', name: 'La Jolla' };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

function createApp({ hostname = 'localhost', apiBaseUrl = '', fetch }) {
  const elements = new Map();
  for (const id of ['stationSelect', 'yearInput', 'loadButton', 'retryButton', 'loadStatus', 'monthSelect', 'daytimeControl', 'chart', 'dayDetails', 'todayButton', 'stationLabel', 'meanHeight', 'ampRange']) {
    elements.set(id, {
      html: '', nodes: [], textContent: '', value: '', disabled: id === 'stationSelect', hidden: false,
      dataset: {}, attributes: {}, listeners: {}, selectedOptions: [{ textContent: 'Santa Monica' }],
      addEventListener(name, callback) { this.listeners[name] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
      querySelectorAll() { return this.nodes; },
      querySelector() { return this.html.includes('plot-border') ? { getBoundingClientRect: () => ({ top: 286 }) } : null; },
      getBoundingClientRect() { return { top: 200 }; },
      get innerHTML() { return this.html; },
      set innerHTML(html) {
        this.html = html;
        if (id !== 'chart') return;
        this.nodes = [...html.matchAll(/<g class="day-target" data-date="([^"]+)" role="button" tabindex="([^"]+)" aria-label="([^"]+)" aria-pressed="([^"]+)"/g)].map((match) => ({
          dataset: { date: match[1] }, attributes: { tabindex: match[2], 'aria-pressed': match[4] },
          setAttribute(name, value) { this.attributes[name] = value; },
          closest() { return this; },
          focus() { elements.get('chart').listeners.focusin({ target: this }); },
        }));
      },
      reportValidity() { return Number.isInteger(Number(this.value)) && Number(this.value) >= 1900 && Number(this.value) <= 2100; },
    });
  }
  const context = vm.createContext({
    document: { querySelector: (selector) => elements.get(selector.slice(1)) },
    location: { hostname }, window: { TIDAL_CONFIG: { apiBaseUrl } },
    fetch, AbortController, setTimeout, clearTimeout,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-10T19:00:00Z'])); } },
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() { this.callback(); } },
    Intl, TypeError, SyntaxError, console,
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
    if (url.endsWith('/api/stations')) return ok({ stations: [fixture.station, otherStation], min_year: 1900, max_year: 2100 });
    if (fail) return { ok: false, json: async () => ({ error: 'NOAA unavailable' }) };
    const year = Number(new URL(url, 'http://localhost').searchParams.get('year'));
    const station = new URL(url, 'http://localhost').searchParams.get('station') === otherStation.id ? otherStation : fixture.station;
    return ok({ ...fixture, station, year, records: fixture.records.map((record) => ({
      ...record, date: `${year}${record.date.slice(4)}`,
      sun_time: `${year}${record.sun_time.slice(4)}`, tide_time: `${year}${record.tide_time.slice(4)}`,
    })) });
  }});
  await flush();
  assert.match(app.elements.get('chart').innerHTML, /calendar-svg/);
  assert.equal(app.elements.get('stationSelect').disabled, false);
  assert.equal(app.run('state.selectedDate'), '2026-10-10');
  assert.match(app.elements.get('dayDetails').innerHTML, /October 10, 2026/);
  assert.equal(app.elements.get('dayDetails').style.values['--calendar-grid-top'], '86px');
  const chart = app.elements.get('chart');
  const day = chart.nodes.find((node) => node.dataset.date === '2026-10-05');
  chart.listeners.click({ target: day });
  assert.match(app.elements.get('dayDetails').innerHTML, /October 5, 2026/);
  let prevented = false;
  chart.listeners.keydown({ target: day, key: 'ArrowDown', preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(app.run('state.selectedDate'), '2026-10-12');
  assert.equal(chart.nodes.filter((node) => node.attributes.tabindex === '0').length, 1);
  const initialRequests = requests.length;
  await app.run('loadCalendar()');
  assert.equal(requests.length, initialRequests, 'same selection is cached in the tab');
  app.elements.get('yearInput').value = '2027';
  await app.run('loadCalendar()');
  assert.equal(app.run('state.data.year'), 2027);
  fail = true;
  app.elements.get('yearInput').value = '2028';
  await app.run('loadCalendar()');
  assert.equal(app.run('state.data.year'), 2027, 'failed request keeps the previous calendar');
  assert.equal(app.elements.get('retryButton').hidden, false);
  assert.match(app.elements.get('loadStatus').textContent, /NOAA unavailable/);
  fail = false;
  await app.elements.get('retryButton').listeners.click();
  assert.equal(app.run('state.data.year'), 2028);
  assert.equal(app.elements.get('retryButton').hidden, true);
  app.run('state.month = 1; state.daytime = "sunrise"; render()');
  await app.elements.get('todayButton').listeners.click();
  assert.equal(app.run('state.data.year'), 2026);
  assert.equal(app.run('state.month'), 10);
  assert.equal(app.run('state.selectedDate'), '2026-10-10');
  assert.match(app.elements.get('dayDetails').innerHTML, /Sunrise/);
  app.elements.get('stationSelect').value = otherStation.id;
  await app.run('loadCalendar()');
  assert.equal(app.elements.get('stationLabel').textContent, 'La Jolla');
  assert.equal(app.run('state.data.station.id'), otherStation.id);
  assert.equal(app.run('state.selectedDate'), '2026-10-10');
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
  assert.equal(saved.run('state.selectedDate'), '2026-10-10');
  saved.run('state.month = 1; render()');
  await saved.elements.get('todayButton').listeners.click();
  assert.equal(saved.run('state.month'), 10);

  let retry = false;
  const unavailable = createApp({ apiBaseUrl: 'https://calendar.example', fetch: async () => {
    if (!retry) throw new TypeError('Network unavailable');
    return ok({ stations: [fixture.station], min_year: 1900, max_year: 2100 });
  }});
  await flush();
  assert.equal(unavailable.elements.get('retryButton').hidden, false);
  assert.match(unavailable.elements.get('loadStatus').textContent, /Could not reach/);
  assert.equal(unavailable.elements.get('loadButton').disabled, true);
  console.log('Frontend checks passed: live loading/caching/retry, day details, keyboard navigation, today selection, saved fallback, and ISO week ordering.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
