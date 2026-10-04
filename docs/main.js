const AVAILABLE_YEARS = [2026, 2027, 2028];
const calendarCache = new Map();
let requestId = 0;
let requestedYear = null;
let requestedInitial = false;
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const state = {
  data: null,
  month: 1,
  daytime: "sunset",
  selectedDate: null,
};

const els = {
  yearSelect: document.querySelector("#yearSelect"),
  calendarStatus: document.querySelector("#calendarStatus"),
  retryButton: document.querySelector("#retryButton"),
  todayButton: document.querySelector("#todayButton"),
  monthSelect: document.querySelector("#monthSelect"),
  daytimeControl: document.querySelector("#daytimeControl"),
  chart: document.querySelector("#chart"),
  dayDetails: document.querySelector("#dayDetails"),
  stationLabel: document.querySelector("#stationLabel"),
  meanHeight: document.querySelector("#meanHeight"),
  ampRange: document.querySelector("#ampRange"),
};

init();

async function init() {
  setupControls();
  const currentYear = Number(dateInTimezone(new Date(), "America/Los_Angeles").slice(0, 4));
  const year = AVAILABLE_YEARS.includes(currentYear) ? currentYear : AVAILABLE_YEARS.at(-1);
  await loadYear(year, true);
}

async function loadYear(year, initial = false) {
  const currentRequest = ++requestId;
  requestedYear = year;
  requestedInitial = initial;
  els.yearSelect.value = String(year);
  els.chart.setAttribute("aria-busy", "true");
  els.calendarStatus.hidden = false;
  els.calendarStatus.textContent = `Loading ${year} calendar…`;
  els.retryButton.hidden = true;
  try {
    let data = calendarCache.get(year);
    if (!data) {
      const response = await fetch(`data/tides-${year}.json`);
      if (!response.ok) throw new Error(`Could not load the ${year} calendar. Please try again.`);
      data = await response.json();
      if (data.year !== year || !Array.isArray(data.records)) throw new Error(`The ${year} calendar data is invalid.`);
      calendarCache.set(year, data);
    }
    if (currentRequest !== requestId) return;
    const firstLoad = !state.data;
    const previousDate = state.selectedDate;
    state.data = data;
    const today = dateInTimezone(new Date(), state.data.station.timezone);
    const todayRecord = state.data.records.find((record) => record.date === today && record.daytime === state.daytime);
    if (initial || firstLoad) {
      state.month = todayRecord?.month || 1;
      state.selectedDate = todayRecord?.date || null;
    } else {
      const date = previousDate ? `${year}${previousDate.slice(4)}` : null;
      state.selectedDate = data.records.some((record) => record.date === date) ? date : null;
      if (!state.selectedDate && todayRecord?.month === state.month) state.selectedDate = todayRecord.date;
    }
    els.monthSelect.value = String(state.month);
    render();
    els.calendarStatus.hidden = true;
  } catch (error) {
    if (currentRequest !== requestId) return;
    els.calendarStatus.textContent = `${error.message}${state.data ? ` Still showing ${state.data.year}.` : ""}`;
    els.retryButton.hidden = false;
    if (state.data) els.yearSelect.value = String(state.data.year);
  } finally {
    if (currentRequest === requestId) els.chart.setAttribute("aria-busy", "false");
  }
}

function dateInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function goToToday() {
  const today = dateInTimezone(new Date(), state.data?.station.timezone || "America/Los_Angeles");
  const year = Number(today.slice(0, 4));
  if (!AVAILABLE_YEARS.includes(year)) {
    els.calendarStatus.hidden = false;
    els.calendarStatus.textContent = `Today’s calendar is unavailable. Available years: ${AVAILABLE_YEARS.join(", ")}.`;
    els.retryButton.hidden = true;
    return;
  }
  await loadYear(year, true);
}

function setupControls() {
  const chartObserver = new ResizeObserver(alignDayDetails);
  chartObserver.observe(els.chart);
  els.yearSelect.innerHTML = AVAILABLE_YEARS.map((year) => `<option value="${year}">${year}</option>`).join("");
  els.yearSelect.addEventListener("change", (event) => loadYear(Number(event.target.value)));
  els.retryButton.addEventListener("click", () => loadYear(requestedYear, requestedInitial || !state.data));
  els.todayButton.addEventListener("click", goToToday);
  els.chart.addEventListener("click", (event) => {
    const day = event.target.closest("[data-date]");
    if (day) {
      selectDay(day.dataset.date);
      day.focus();
    }
  });

  els.chart.addEventListener("focusin", (event) => {
    const day = event.target.closest("[data-date]");
    if (day) selectDay(day.dataset.date);
  });

  els.chart.addEventListener("keydown", (event) => {
    const day = event.target.closest("[data-date]");
    if (!day) return;
    const days = [...els.chart.querySelectorAll("[data-date]")];
    const index = days.indexOf(day);
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next;
    if (event.key in offsets) next = index + offsets[event.key];
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = days.length - 1;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectDay(day.dataset.date);
      return;
    } else return;
    event.preventDefault();
    days[Math.max(0, Math.min(days.length - 1, next))].focus();
  });

  els.monthSelect.innerHTML = MONTHS.map((name, index) => {
    const month = index + 1;
    return `<option value="${month}">${name}</option>`;
  }).join("");
  els.monthSelect.value = String(state.month);

  els.monthSelect.addEventListener("change", (event) => {
    state.month = Number(event.target.value);
    render();
  });

  els.daytimeControl.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-daytime]");
    if (!button) return;

    state.daytime = button.dataset.daytime;
    for (const option of els.daytimeControl.querySelectorAll("button")) {
      option.setAttribute("aria-checked", String(option === button));
    }
    render();
  });
}

function render() {
  if (!state.data) return;
  const records = recordsForSelection();
  const monthName = MONTHS[state.month - 1];
  const eventName = titleCase(state.daytime);
  if (!records.some((record) => record.date === state.selectedDate)) state.selectedDate = null;

  els.stationLabel.textContent = state.data.station.name;

  renderStats(records);
  renderSvg(records, monthName, eventName);
  alignDayDetails();
  renderDayDetails(records.find((record) => record.date === state.selectedDate));
}

function alignDayDetails() {
  const grid = els.chart.querySelector(".plot-border");
  if (!grid) return;
  const bounds = grid.getBoundingClientRect();
  const top = bounds.top - els.chart.getBoundingClientRect().top;
  els.dayDetails.style.setProperty("--calendar-grid-top", `${top}px`);
}

function selectDay(date) {
  const record = recordsForSelection().find((item) => item.date === date);
  if (!record || state.selectedDate === date) return;
  state.selectedDate = date;
  for (const day of els.chart.querySelectorAll("[data-date]")) {
    const selected = day.dataset.date === date;
    day.setAttribute("aria-pressed", String(selected));
    day.setAttribute("tabindex", selected ? "0" : "-1");
  }
  renderDayDetails(record);
}

function renderDayDetails(record) {
  if (!record) {
    els.dayDetails.innerHTML = '<p>Tap a day or focus the calendar and use the arrow keys to see its details.</p>';
    return;
  }
  const fields = [
    ["Predicted height", `${record.height_m.toFixed(2)} m (MLLW)`],
    ["Tide time", formatTime(record.tide_time)],
    [titleCase(record.daytime), formatTime(record.sun_time)],
    ["Normalized height", record.normalized_amplitude.toFixed(2)],
    ["Moon phase", record.moon_phase_name],
  ];
  els.dayDetails.innerHTML = `
    <h2>${escapeHtml(`${record.weekday_name}, ${MONTHS[record.month - 1]} ${record.day}, ${state.data.year}`)}</h2>
    <p class="details-timezone">Times in ${escapeHtml(state.data.station.timezone)}</p>
    <dl>${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
  `;
}

function recordsForSelection() {
  return state.data.records
    .filter((record) => record.month === state.month && record.daytime === state.daytime)
    .sort((a, b) => a.day - b.day);
}

function renderStats(records) {
  if (records.length === 0) {
    els.meanHeight.textContent = "--";
    els.ampRange.textContent = "--";
    return;
  }

  const heights = records.map((record) => record.height_m);
  const amps = records.map((record) => record.normalized_amplitude);
  const meanHeight = heights.reduce((sum, value) => sum + value, 0) / heights.length;

  els.meanHeight.textContent = `${meanHeight.toFixed(2)} m`;
  els.ampRange.textContent = `${Math.min(...amps).toFixed(2)} to ${Math.max(...amps).toFixed(2)}`;
}

function renderSvg(records, monthName, eventName) {
  if (records.length === 0) {
    els.chart.innerHTML = '<p class="empty-state">No data for this selection.</p>';
    return;
  }

  const width = 740;
  const margin = { top: 86, right: 44, bottom: 78, left: 74 };
  // ISO week numbers wrap at New Year; retain their calendar order.
  const weeks = [...new Set(records.map((record) => record.week))];
  const plotWidth = width - margin.left - margin.right;
  const height = (margin.top + weeks.length * 76 + margin.bottom) * 1.1;
  const plotHeight = height - margin.top - margin.bottom;
  const rowHeight = plotHeight / weeks.length;
  const colWidth = plotWidth / 7;

  const weekIndex = new Map(weeks.map((week, index) => [week, index]));
  const gridLines = [];
  const dots = [];

  for (let i = 0; i <= 7; i += 1) {
    const x = margin.left + i * colWidth;
    gridLines.push(svgLine(x, margin.top, x, margin.top + plotHeight, "grid-line"));
  }

  for (let i = 0; i <= weeks.length; i += 1) {
    const y = margin.top + i * rowHeight;
    gridLines.push(svgLine(margin.left, y, margin.left + plotWidth, y, "grid-line"));
  }

  for (const record of records) {
    const x = margin.left + (record.weekday - 1) * colWidth + colWidth / 2;
    const row = weekIndex.get(record.week);
    const y = margin.top + row * rowHeight + rowHeight / 2;
    const amp = record.normalized_amplitude;
    const radius = 5 + Math.abs(amp) * 22;
    const tideTime = formatTime(record.tide_time);
    const sunTime = formatTime(record.sun_time);
    const title = [
      `${record.weekday_name}, ${monthName} ${record.day}`,
      `${eventName}: ${sunTime}`,
      `Predicted tide: ${tideTime}, ${record.height_m.toFixed(2)} m`,
      `Normalized height: ${amp.toFixed(2)}`,
      record.moon_phase_name,
    ].join(" | ");

    dots.push(`
      <g class="day-target" data-date="${escapeHtml(record.date)}" role="button" tabindex="${record.date === (state.selectedDate || records[0].date) ? "0" : "-1"}" aria-label="${escapeHtml(title)}" aria-pressed="${record.date === state.selectedDate}" aria-controls="dayDetails">
        <rect class="day-hit" x="${(x - colWidth / 2 + 3).toFixed(2)}" y="${(y - rowHeight / 2 + 3).toFixed(2)}" width="${(colWidth - 6).toFixed(2)}" height="${rowHeight - 6}" rx="6"></rect>
        <circle class="tide-dot" cx="${x.toFixed(2)}" cy="${(y - 9).toFixed(2)}" r="${radius.toFixed(2)}" fill="${colorForAmplitude(amp)}">
          <title>${escapeHtml(title)}</title>
        </circle>
        <text class="day-label" x="${x.toFixed(2)}" y="${(y + 26).toFixed(2)}" text-anchor="middle">${record.day}</text>
      </g>
    `);
  }

  const weekdayLabels = WEEKDAYS.map((label, index) => {
    const x = margin.left + index * colWidth + colWidth / 2;
    return `<text class="axis-label" x="${x.toFixed(2)}" y="${(margin.top + plotHeight + 24).toFixed(2)}" text-anchor="middle">${label}</text>`;
  }).join("");

  const weekLabels = weeks.map((week, index) => {
    const y = margin.top + index * rowHeight + rowHeight / 2 + 5;
    return `<text class="week-label" x="${margin.left - 10}" y="${y.toFixed(2)}" text-anchor="end">${week}</text>`;
  }).join("");

  els.chart.innerHTML = `
    <svg class="calendar-svg" viewBox="0 0 ${width} ${height}" role="group" aria-labelledby="svgTitle" aria-describedby="svgDesc">
      <title id="svgTitle">${monthName} ${state.data.year} ${state.daytime} tide calendar</title>
      <desc id="svgDesc">Calendar grid with one selectable day per date showing predicted tide height nearest ${state.daytime}. Use arrow keys to move by day or week, Home and End for the first and last day, or tap a day for details. Color scales from the annual low to the annual high. Circle size shows distance from their midpoint.</desc>
      <text class="month-title" x="${margin.left}" y="46">${monthName}</text>
      <text class="axis-label" x="${margin.left}" y="70">Predicted tide height at ${state.daytime}</text>
      ${gridLines.join("")}
      <rect class="plot-border" x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}"></rect>
      ${weekLabels}
      ${dots.join("")}
      ${weekdayLabels}
    </svg>
  `;
}

function svgLine(x1, y1, x2, y2, className) {
  return `<line class="${className}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"></line>`;
}

function colorForAmplitude(value) {
  const low = [123, 215, 238];
  const mid = [107, 92, 149];
  const high = [243, 182, 95];

  if (value < 0) {
    return rgb(interpolate(low, mid, value + 1));
  }

  return rgb(interpolate(mid, high, value));
}

function interpolate(start, end, amount) {
  return start.map((value, index) => Math.round(value + (end[index] - value) * amount));
}

function rgb(parts) {
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
}

function formatTime(value) {
  return value.slice(11, 16);
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
