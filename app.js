"use strict";

// Types put in EXCLUDED are left out of the chart, which is how transfers
// between own accounts are kept from swamping the actual costs.
const EXCLUDED = "Excluded";
const BUILTIN_CATEGORIES = [
  "Rent", "Food", "Food (takeout)", "Clothes", "Car (gas)", "Car (repair)",
  "Entertainment", "Utilities", "Medicine", "Car (other)",
];
const UNCATEGORIZED = "Uncategorized";

// Initialised below, once BANK_PARSERS exists — deriving the types needs it.
let bank;
let transactions;
let assignments = load("cc.assignments", {});   // type -> category

// Only the user's own categories are stored. The built-in ones come from the
// code every time, so adding one here shows up without anything having to
// rewrite what is already in localStorage.
let customCategories = load("cc.customCategories", []);
let categories = [];

function rebuildCategories() {
  categories = [
    ...BUILTIN_CATEGORIES,
    ...customCategories.filter((c) => !BUILTIN_CATEGORIES.includes(c) && c !== EXCLUDED),
    EXCLUDED,
  ];
}
rebuildCategories();

// Individually excluded transactions, by row key. Deliberately kept when the
// transactions themselves are dropped, so reloading a statement does not lose
// the exclusions that were picked out by hand.
let excludedTx = new Set(load("cc.excludedTx", []));
const saveExcludedTx = () => save("cc.excludedTx", [...excludedTx]);


function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

/* ---------- CSV parsing ---------- */

// Each bank gets its own parser: `matches` inspects the header row, `parse`
// turns a bank-specific row into the generic {date, id, description, amount},
// and `inferType` reduces a description to the type it is grouped under.
const BANK_PARSERS = [
  {
    name: "Swedbank",
    matches: (header) => header.includes("Bokföringsdatum") && header.includes("Belopp"),
    parse: (row, header) => {
      const col = (name) => row[header.indexOf(name)];
      return {
        date: (col("Bokföringsdatum") || "").trim(),
        id: (col("Verifikationsnummer") || "").trim(),
        description: (col("Text") || "").trim(),
        amount: parseAmount(col("Belopp")),
      };
    },
    inferType: inferTypeSwedbank,
  },
];

function parserNamed(name) {
  return BANK_PARSERS.find((p) => p.name === name) || BANK_PARSERS[0];
}

// "MAXI ICA STO/26-07-13" -> "MAXI ICA STO", but "APPLE COM/BI" keeps its slash
// because it is not followed by a date.
function inferTypeSwedbank(description) {
  const withoutDate = description.replace(/\/\d{2}-\d{2}-\d{2}\s*$/, "").trim();

  // Swedbank's Spotify line carries something that changes every charge — a
  // per-charge reference code ("SPOTIFY P446") in recent statements, no space
  // before the merchant ID ("SPOTIFYSE") in older ones — so left alone every
  // payment becomes its own type instead of one "SPOTIFY" to categorize once.
  if (/^SPOTIFY/i.test(withoutDate)) return "SPOTIFY";

  return withoutDate;
}

function parseAmount(raw) {
  if (!raw) return 0;
  const cleaned = raw.replace(/\s| /g, "").replace(",", ".");
  const value = parseFloat(cleaned);
  return isNaN(value) ? 0 : value;
}

function splitCsvLine(line) {
  return line.split(";").map((cell) => cell.replace(/^"|"$/g, ""));
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error("CSV has no data rows");

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const parser = BANK_PARSERS.find((p) => p.matches(header));
  if (!parser) throw new Error("Unrecognized CSV format: " + header.join(";"));

  const rows = lines.slice(1)
    .map((line) => parser.parse(splitCsvLine(line), header))
    .filter((t) => t.date);
  return { bank: parser.name, rows: assignDerived(rows, parser.name) };
}

// `type` and `key` are both worked out from what the CSV said, so they are
// derived on every load rather than stored: changing how a type is inferred
// then takes effect on a reload, without the statement having to be imported
// again.
function assignDerived(list, bank) {
  const inferType = parserNamed(bank).inferType;
  for (const t of list) t.type = inferType(t.description);
  return assignKeys(list);
}

// Verifikationsnummer is not unique — in a real statement one value covered 671
// rows, and even whole CSV lines can repeat — so per-transaction exclusions are
// keyed on the whole row plus a counter for the rows that are still identical.
// It has to be built from the full list, since a filtered list would renumber
// the duplicates.
function assignKeys(list) {
  const seen = new Map();
  for (const t of list) {
    const base = `${t.date}|${t.id}|${t.description}|${t.amount}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    t.key = n === 0 ? base : `${base}#${n}`;
  }
  return list;
}

bank = load("cc.bank", BANK_PARSERS[0].name);
transactions = assignDerived(load("cc.transactions", []), bank);

/* ---------- loading ---------- */

const statusEl = document.getElementById("status");
const dropBtn = document.getElementById("drop-btn");

let statusBase = "";

function setStatus(text) {
  statusBase = text;
  renderStatus();
}

function renderStatus() {
  const shown = visible().length;
  const filtered = currentRange().id !== "all" && transactions.length > 0;
  statusEl.textContent = filtered ? `${statusBase} (${shown} in range)` : statusBase;
  dropBtn.hidden = transactions.length === 0;
  syncRangeControls();
}

document.getElementById("load-btn").onclick = () =>
  document.getElementById("file-input").click();

// Only drops the transactions; categories, their assignments and the
// per-transaction exclusions are kept so a freshly loaded statement lands in
// the setup that is already there.
dropBtn.onclick = () => {
  if (!confirm("Drop the loaded transactions from localstorage?")) return;
  transactions = [];
  localStorage.removeItem("cc.transactions");
  setStatus("");
  renderAll();
};

document.getElementById("file-input").onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseCsv(reader.result);
      transactions = parsed.rows;
      bank = parsed.bank;
      save("cc.bank", bank);
      // `type` and `key` are derived on load, so they are stripped rather than
      // persisted — only what the CSV actually said is kept.
      save("cc.transactions", transactions.map(({ type, key, ...rest }) => rest));
      setStatus(`${transactions.length} transactions from ${file.name}`);
      renderAll();
    } catch (err) {
      setStatus("Error: " + err.message);
    }
  };
  reader.readAsText(file, "utf-8");
  e.target.value = "";   // let the same file be picked again
};

/* ---------- URL state ---------- */

// Which tab is open, the period shown and what the chart is doing with it all
// live in the query string, so they survive a reload and the address bar
// doubles as a link to that exact view. Only the tabs push a history entry:
// stepping back through every legend click would bury the navigation worth
// going back to.
function urlParams() {
  return new URLSearchParams(location.search);
}

// A key with an array value becomes one parameter per entry, which keeps
// category names with a comma in them from needing a separator of their own.
// A null value drops the parameter instead of writing it empty.
function writeUrl(changes, push) {
  const url = new URL(location);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      url.searchParams.delete(key);
    } else if (Array.isArray(value)) {
      url.searchParams.delete(key);
      for (const one of value) url.searchParams.append(key, one);
    } else {
      url.searchParams.set(key, value);   // in place, so the order stays put
    }
  }
  history[push ? "pushState" : "replaceState"]({}, "", url);
}

/* ---------- date range filter ---------- */

// Ranges are relative to today and expressed as an inclusive ISO start date, so
// they can be compared against the transaction dates as plain strings. The
// custom one is the exception: it carries both of its bounds, either of which
// may be left open.
const RANGES = [
  { id: "all", label: "All", start: () => null },
  { id: "5y", label: "Last 5 years", start: () => backTo(5, 0) },
  { id: "3y", label: "Last 3 years", start: () => backTo(3, 0) },
  { id: "2y", label: "Last 2 years", start: () => backTo(2, 0) },
  { id: "1y", label: "Last 1 year", start: () => backTo(1, 0) },
  { id: "ytd", label: "Year to date", start: () => isoDate(new Date(new Date().getFullYear(), 0, 1)) },
  { id: "6m", label: "Last 6 months", start: () => backTo(0, 6) },
  { id: "3m", label: "Last 3 months", start: () => backTo(0, 3) },
  { id: "1m", label: "Last month", start: () => backTo(0, 1) },
  { id: "custom", label: "Custom…", start: () => null },
];

const CUSTOM = "custom";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(d) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

// Clamps the day so that going back from e.g. the 31st lands on the last day of
// a shorter month rather than spilling into the next one. The day after that is
// the inclusive start: "last 1 year" then covers a year up to and including
// today, not a year and a day.
function backTo(years, months) {
  const today = new Date();
  const target = new Date(today.getFullYear() - years, today.getMonth() - months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(today.getDate(), lastDay) + 1);
  return isoDate(target);
}

// The period is in the URL, so a link decides what its recipient sees, and it
// is saved as well, so a visit without one comes back to whatever was picked
// last. Opening someone else's link does not overwrite that.
let savedRange = load("cc.range", "all");
if (!RANGES.some((r) => r.id === savedRange)) savedRange = "all";
let savedCustom = load("cc.customRange", { from: null, to: null });

// Dates are compared as plain strings everywhere, so a well-formed but
// impossible one — a hand-edited "2024-13-99" — would quietly act as a bound
// that sorts somewhere. The parts are checked against a real date instead.
function isoOrNull(value) {
  if (!ISO_DATE.test(value || "")) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? value : null;
}

// {id, from, to}, where from and to only mean anything for the custom range and
// a null bound there is an open end.
function currentRange() {
  const params = urlParams();
  const id = params.get("range");
  if (id === CUSTOM) {
    return { id, from: isoOrNull(params.get("from")), to: isoOrNull(params.get("to")) };
  }
  if (RANGES.some((r) => r.id === id)) return { id, from: null, to: null };
  return savedRange === CUSTOM
    ? { id: CUSTOM, from: isoOrNull(savedCustom.from), to: isoOrNull(savedCustom.to) }
    : { id: savedRange, from: null, to: null };
}

// The two inclusive ISO bounds of the selected period; null is an open end.
function rangeBounds() {
  const range = currentRange();
  if (range.id === CUSTOM) return { start: range.from, end: range.to };
  return { start: RANGES.find((r) => r.id === range.id).start(), end: null };
}

// Every tab renders from this rather than from `transactions` directly.
function visible() {
  const { start, end } = rangeBounds();
  if (start === null && end === null) return transactions;
  return transactions.filter((t) =>
    (start === null || t.date >= start) && (end === null || t.date <= end));
}

const rangeEl = document.getElementById("range");
const customEl = document.getElementById("custom-range");
const fromEl = document.getElementById("range-from");
const toEl = document.getElementById("range-to");
for (const r of RANGES) rangeEl.add(new Option(r.label, r.id));

// The controls are a view of the URL, the same way the group-by radios are.
function syncRangeControls() {
  const range = currentRange();
  rangeEl.value = range.id;
  rangeEl.hidden = transactions.length === 0;
  customEl.hidden = transactions.length === 0 || range.id !== CUSTOM;
  fromEl.value = range.from || "";
  toEl.value = range.to || "";
}

rangeEl.onchange = () => {
  savedRange = rangeEl.value;
  save("cc.range", savedRange);
  // Picking "Custom…" comes back to the dates last used, if there are any.
  writeUrl(savedRange === CUSTOM
    ? { range: CUSTOM, from: isoOrNull(savedCustom.from), to: isoOrNull(savedCustom.to) }
    : { range: savedRange, from: null, to: null });
  syncRangeControls();
  renderAll();
};

// Free text now (see index.html for why), so unlike a native date input this
// can hold anything typed; isoOrNull is what turns garbage into an open bound,
// and syncRangeControls snaps the field back to whatever that resolved to.
function onCustomBoundChange() {
  savedCustom = { from: isoOrNull(fromEl.value), to: isoOrNull(toEl.value) };
  save("cc.customRange", savedCustom);
  writeUrl({ range: CUSTOM, from: savedCustom.from, to: savedCustom.to });
  syncRangeControls();
  renderAll();
}
fromEl.onchange = toEl.onchange = onCustomBoundChange;

// The 📅 button is the only use for these: a real date input, kept off-screen,
// opened on demand so picking a date does not require a browser whose date
// picker happens to render YYYY-MM-DD.
function wirePicker(textEl, nativeEl, buttonId) {
  document.getElementById(buttonId).onclick = () => {
    nativeEl.value = isoOrNull(textEl.value) || "";
    if (nativeEl.showPicker) nativeEl.showPicker();
    else nativeEl.focus();   // older browsers: focus at least reveals a picker
  };
  nativeEl.onchange = () => {
    textEl.value = nativeEl.value;
    onCustomBoundChange();
  };
}
wirePicker(fromEl, document.getElementById("range-from-native"), "range-from-pick");
wirePicker(toEl, document.getElementById("range-to-native"), "range-to-pick");

/* ---------- tabs ---------- */

const PAGES = ["data", "categories", "chart"];

function currentPage() {
  const page = urlParams().get("page");
  return PAGES.includes(page) ? page : "data";
}

function showPage(page, push) {
  for (const p of PAGES) {
    document.getElementById("page-" + p).classList.toggle("active", p === page);
  }
  for (const btn of document.querySelectorAll("#tabs button")) {
    btn.classList.toggle("active", btn.dataset.page === page);
  }
  if (push) writeUrl({ page }, true);
  // Both tabs are rendered on show: the canvas needs to be visible to size
  // itself, and the data tab's "Excluded category?" column goes stale as soon
  // as an assignment changes on the categories tab.
  if (page === "chart") renderChart();
  if (page === "data") renderData();
}

for (const btn of document.querySelectorAll("#tabs button")) {
  btn.onclick = () => showPage(btn.dataset.page, true);
}

// Going back or forward re-reads everything from the URL — period and chart
// controls included, since the entry stepped onto may have been left anywhere.
window.onpopstate = () => {
  syncGroupByRadio();
  renderStatus();
  renderCategories();               // the one tab showPage does not render
  showPage(currentPage(), false);
};

/* ---------- Data tab ---------- */

let dataSort = { key: "date", dir: "desc" };

function sortRows(rows, sort) {
  const { key, dir } = sort;
  const factor = dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    if (typeof x === "number" && typeof y === "number") return (x - y) * factor;
    return String(x).localeCompare(String(y), "sv") * factor;
  });
}

function bindSorting(table, sort, rerender) {
  for (const th of table.querySelectorAll("th.sortable")) {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (sort.key === key) {
        sort.dir = sort.dir === "asc" ? "desc" : "asc";
      } else {
        sort.key = key;
        sort.dir = "asc";
      }
      rerender();
    };
  }
}

function markSortIndicators(table, sort) {
  for (const th of table.querySelectorAll("th.sortable")) {
    const base = th.textContent.replace(/ [▲▼]$/, "");
    th.textContent = th.dataset.sort === sort.key
      ? base + (sort.dir === "asc" ? " ▲" : " ▼")
      : base;
  }
}

// Amounts are shown rounded to whole kronor to keep the columns scannable; the
// exact figure, always with two decimals, is available on hover.
const kronor = (n) => n.toLocaleString("sv-SE", { maximumFractionDigits: 0 });
const kronorExact = (n) =>
  n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr";

// An empty tab means either "nothing loaded" or "nothing in the chosen range".
function setEmptyMessage(el, loadHint) {
  el.textContent = transactions.length === 0
    ? (loadHint || "No transactions loaded.")
    : "No transactions in the selected period.";
}

function renderData() {
  const table = document.getElementById("data-table");
  const empty = document.getElementById("data-empty");
  const rows = visible();
  table.hidden = rows.length === 0;
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    setEmptyMessage(empty, 'No transactions loaded. Click "Load transactions" to pick a .csv file.');
    return;
  }

  markSortIndicators(table, dataSort);
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";
  // `excluded` is derived from the category the type sits in, so it is attached
  // here rather than stored on the transaction.
  const decorated = rows.map((t) => ({
    ...t,
    excluded: assignments[t.type] === EXCLUDED ? EXCLUDED : "",
    manual: excludedTx.has(t.key) ? EXCLUDED : "",
  }));
  for (const t of sortRows(decorated, dataSort)) {
    const tr = tbody.insertRow();
    const date = tr.insertCell();
    date.textContent = t.date;
    date.className = "date";
    tr.insertCell().textContent = t.type;
    tr.insertCell().textContent = t.description;
    const amount = tr.insertCell();
    amount.textContent = kronor(t.amount);
    amount.title = kronorExact(t.amount);
    amount.className = "amount" + (t.amount < 0 ? " negative" : "");
    tr.insertCell().textContent = t.excluded;

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = excludedTx.has(t.key);
    box.onchange = () => {
      if (box.checked) excludedTx.add(t.key);
      else excludedTx.delete(t.key);
      saveExcludedTx();
    };
    tr.insertCell().appendChild(box);
  }
}

bindSorting(document.getElementById("data-table"), dataSort, renderData);

/* ---------- Categories tab ---------- */

let typeSort = { key: "total", dir: "desc" };

// One row per distinct transaction type, with how often it occurs and how much
// it has cost in total (costs only, as a positive number).
function typeSummary() {
  const byType = new Map();
  for (const t of visible()) {
    let entry = byType.get(t.type);
    if (!entry) {
      entry = { type: t.type, count: 0, total: 0 };
      byType.set(t.type, entry);
    }
    entry.count++;
    if (t.amount < 0) entry.total += -t.amount;
  }
  return [...byType.values()];
}

function renderCategories() {
  const table = document.getElementById("types-table");
  const empty = document.getElementById("cat-empty");
  const types = typeSummary();
  table.hidden = types.length === 0;
  empty.hidden = types.length > 0;
  if (!types.length) {
    setEmptyMessage(empty, "No transactions loaded, so there are no types to categorize yet.");
    return;
  }

  markSortIndicators(table, typeSort);
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";
  for (const row of sortRows(types, typeSort)) {
    const tr = tbody.insertRow();
    tr.insertCell().textContent = row.type;
    const count = tr.insertCell();
    count.textContent = row.count;
    count.className = "amount";
    const total = tr.insertCell();
    total.textContent = kronor(row.total);
    total.title = kronorExact(row.total);
    total.className = "amount";

    // Excluded sits right after the blank option: it is the one picked most
    // often when working down the list of uncategorized types.
    const select = document.createElement("select");
    const addOption = (label, value) => {
      const option = new Option(label, value);
      if (value) {
        option.style.background = categoryColor(value);
        option.style.color = textOn(categoryColor(value));
      }
      select.add(option);
    };
    addOption("—", "");
    addOption(EXCLUDED, EXCLUDED);
    for (const cat of categories) {
      if (cat !== EXCLUDED) addOption(cat, cat);
    }
    select.value = assignments[row.type] || "";
    // The closed picker carries the colour of whatever is selected, so the
    // column can be read as a block without opening anything.
    const paint = () => {
      const swatch = select.value ? categoryColor(select.value) : "";
      select.style.background = swatch;
      select.style.color = swatch ? textOn(swatch) : "";
    };
    paint();
    select.onchange = () => {
      if (select.value) assignments[row.type] = select.value;
      else delete assignments[row.type];
      save("cc.assignments", assignments);
      paint();
    };
    tr.insertCell().appendChild(select);
  }
}

bindSorting(document.getElementById("types-table"), typeSort, renderCategories);

document.getElementById("add-category").onclick = () => {
  const input = document.getElementById("new-category");
  const name = input.value.trim();
  if (name && !categories.includes(name)) {
    customCategories.push(name);
    save("cc.customCategories", customCategories);
    rebuildCategories();
    renderCategories();
  }
  input.value = "";
};

/* ---------- Chart tab ---------- */

let chart = null;

function isoWeek(date) {
  // Thursday of the current week decides the ISO year and week number.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

function bucketOf(dateStr, groupBy) {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  switch (groupBy) {
    case "year": return String(year);
    case "quarter": return year + "-Q" + (Math.floor(date.getMonth() / 3) + 1);
    case "month": return year + "-" + String(date.getMonth() + 1).padStart(2, "0");
    case "week": return isoWeek(date);
  }
}

// First day of the bucket a date falls in.
function bucketFloor(date, groupBy) {
  switch (groupBy) {
    case "year": return new Date(date.getFullYear(), 0, 1);
    case "quarter": return new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1);
    case "month": return new Date(date.getFullYear(), date.getMonth(), 1);
    case "week": {   // ISO weeks start on Monday, like `isoWeek` above
      const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      return monday;
    }
  }
}

// The date ranges are counted back from today, so their start lands wherever it
// lands inside a bucket. Charting straight from there leaves a stub bucket at
// the left edge — "last 1 year" by quarter would draw five of them, the oldest
// holding a few days — which also drags the per-bucket averages down. So the
// chart starts at the first bucket the range covers in full, which is what
// makes the bucket count come out as the range name implies. A custom period is
// left alone: dates that were typed in are shown as typed, stub bucket and all.
function chartStart(groupBy) {
  const { id } = currentRange();
  const start = rangeBounds().start;
  if (start === null || id === CUSTOM) return start;
  const floor = bucketFloor(new Date(start), groupBy);
  if (isoDate(floor) >= start) return isoDate(floor);
  const next = new Date(floor);
  if (groupBy === "week") next.setDate(next.getDate() + 7);
  else next.setMonth(next.getMonth() + { year: 12, quarter: 3, month: 1 }[groupBy]);
  // Unless skipping ahead would skip the range entirely — a short range grouped
  // coarsely, say three months by year. One partial bucket beats no chart.
  return isoDate(next) > isoDate(new Date()) ? start : isoDate(next);
}

const GROUP_BYS = ["year", "quarter", "month", "week"];
const DEFAULT_GROUP_BY = "quarter";

// The URL is what the chart reads, and the radios are just its view of it —
// that way a reload, a shared link and a click on a radio all go through the
// same path. Same for the categories hidden by clicking the legend; names that
// no longer exist simply never match anything.
function selectedGroupBy() {
  const group = urlParams().get("group");
  return GROUP_BYS.includes(group) ? group : DEFAULT_GROUP_BY;
}

function hiddenCategories() {
  return new Set(urlParams().getAll("hide"));
}

function syncGroupByRadio() {
  document.querySelector(`input[name="groupby"][value="${selectedGroupBy()}"]`).checked = true;
}

const BUCKET_NOUN = { year: "year", quarter: "quarter", month: "month", week: "week" };

let summarySort = { key: "total", dir: "desc" };
// Categories to show, totals and labels to compute from, and the current
// group-by — cached so a re-sort (or a legend click hiding a category) can
// redraw the table without recomputing it from the transactions again.
let chartSummaryState = null;

// Per-category totals under the chart, with the average over the buckets the
// chart is actually showing — so it tracks both the group-by and the date range.
function renderChartSummary(stackOrder, totals, labels, groupBy) {
  chartSummaryState = { stackOrder, totals, labels, groupBy };
  drawChartSummary();
}

function drawChartSummary() {
  const { stackOrder, totals, labels, groupBy } = chartSummaryState;
  const table = document.getElementById("chart-summary");
  table.hidden = false;
  document.getElementById("summary-average").textContent =
    `Average cost per ${BUCKET_NOUN[groupBy]}`;

  const rows = stackOrder.map((category) => {
    const total = labels.reduce((sum, b) => sum + (totals.get(b).get(category) || 0), 0);
    return { category, total, average: total / labels.length };
  });
  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);

  markSortIndicators(table, summarySort);
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";
  for (const row of sortRows(rows, summarySort)) {
    const tr = tbody.insertRow();
    const name = tr.insertCell();
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = categoryColor(row.category);
    name.append(swatch, row.category);
    addAmount(tr, row.total);
    addAmount(tr, row.average);
  }

  const foot = table.querySelector("tfoot") || table.createTFoot();
  foot.innerHTML = "";
  const tr = foot.insertRow();
  tr.insertCell().textContent = `Total over ${labels.length} ${BUCKET_NOUN[groupBy]}s`;
  addAmount(tr, grandTotal);
  addAmount(tr, grandTotal / labels.length);
}

bindSorting(document.getElementById("chart-summary"), summarySort, drawChartSummary);

function addAmount(tr, value) {
  const cell = tr.insertCell();
  cell.textContent = kronor(value);
  cell.title = kronorExact(value);
  cell.className = "amount";
}

// A fixed, validated categorical palette rather than generated hues: the order
// is what keeps neighbouring stack layers apart for colourblind readers, so
// slots are handed out in order and never cycled. Colour follows the category
// itself, not its position in the chart, so filtering never repaints anything.
const SERIES_COLORS = [
  "#2a78d6",  // blue
  "#eb6834",  // orange
  "#1baf7a",  // aqua
  "#eda100",  // yellow
  "#e87ba4",  // magenta
  "#008300",  // green
  "#4a3aa7",  // violet
  "#e34948",  // red
  "#7a5cc4",  // light violet
  "#8a2a5c",  // plum
];
const OVERFLOW_COLOR = "#8a8983";   // past the palette; see categoryColor
const UNCATEGORIZED_COLOR = "#b8b7b2";
const EXCLUDED_COLOR = "#e0dfda";

// Single source of truth for category colours, shared by the chart and the
// category pickers. The two that never carry a hue are the ones that are not
// really categories: one is not charted, the other is the absence of a choice.
function categoryColor(category) {
  if (category === EXCLUDED) return EXCLUDED_COLOR;
  if (category === UNCATEGORIZED) return UNCATEGORIZED_COLOR;
  // Excluded is skipped so it does not consume a hue slot.
  const i = categories.filter((c) => c !== EXCLUDED).indexOf(category);
  return i >= 0 && i < SERIES_COLORS.length ? SERIES_COLORS[i] : OVERFLOW_COLOR;
}

// Black or white, whichever contrasts more with the swatch behind it.
function textOn(hex) {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? "#000" : "#fff";
}

// The chart totals are keyed bucket -> category, and the tooltip needs one
// level deeper, so both are filled through the same pair of one-liners.
function nested(map, key) {
  if (!map.has(key)) map.set(key, new Map());
  return map.get(key);
}

function addTo(map, key, amount) {
  map.set(key, (map.get(key) || 0) + amount);
}

function renderChart() {
  const empty = document.getElementById("chart-empty");
  const canvas = document.getElementById("chart");
  const groupBy = selectedGroupBy();
  const start = chartStart(groupBy);
  const end = rangeBounds().end;
  const rows = transactions.filter((t) =>
    (start === null || t.date >= start) && (end === null || t.date <= end));
  const totals = new Map();       // bucket -> category -> cost
  const byType = new Map();       // bucket -> category -> type -> cost
  const usedCategories = new Set();

  for (const t of rows) {
    if (t.amount >= 0) continue;  // costs only
    if (excludedTx.has(t.key)) continue;
    const category = assignments[t.type] || UNCATEGORIZED;
    if (category === EXCLUDED) continue;
    const bucket = bucketOf(t.date, groupBy);
    addTo(nested(totals, bucket), category, -t.amount);
    addTo(nested(nested(byType, bucket), category), t.type, -t.amount);
    usedCategories.add(category);
  }

  const labels = [...totals.keys()].sort();

  // Nothing chartable: no data at all, none in range, or everything left is
  // income or excluded.
  empty.hidden = labels.length > 0;
  canvas.hidden = labels.length === 0;
  if (!labels.length) {
    if (rows.length) empty.textContent = "No costs to chart in the selected period.";
    else setEmptyMessage(empty);
    if (chart) { chart.destroy(); chart = null; }
    document.getElementById("chart-summary").hidden = true;
    return;
  }

  const stackOrder = categories.filter((c) => usedCategories.has(c));
  if (usedCategories.has(UNCATEGORIZED)) stackOrder.push(UNCATEGORIZED);

  // Colour by position in `categories` so a category keeps its colour even as
  // other categories appear and disappear from the stack.
  const hidden = hiddenCategories();
  const datasets = stackOrder.map((category) => ({
    label: category,
    data: labels.map((b) => totals.get(b).get(category) || 0),
    backgroundColor: categoryColor(category),
    hidden: hidden.has(category),
    // A hairline of surface between stacked segments so touching fills stay
    // separable; only on top, so narrow bars keep their width.
    borderColor: "#fff",
    borderWidth: { top: 2 },
    borderSkipped: false,
  }));

  renderChartSummary(stackOrder.filter((c) => !hidden.has(c)), totals, labels, groupBy);

  // Under the segment's own total, what it is actually made of: every type in
  // that category and bucket, dearest first, so a bar that stands out explains
  // itself without a trip to the Categories tab.
  const typeLines = (context) => {
    const perCategory = byType.get(context.label);
    const perType = perCategory && perCategory.get(context.dataset.label);
    if (!perType) return [];
    return [...perType]
      .sort((a, b) => b[1] - a[1])
      .map(([type, cost]) => `    ${type}: ${kronorExact(cost)}`);
  };

  if (chart) chart.destroy();
  chart = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true },
        y: {
          stacked: true,
          title: { display: true, text: "kronor" },
          ticks: { callback: (v) => kronor(v) },
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${kronorExact(c.parsed.y)}`,
            afterLabel: typeLines,
          },
        },
        // Clicking a legend entry hides that category's bars (Chart.js default
        // behaviour); mirror the same hide/show onto the summary table below so
        // its rows and total only ever reflect what the chart is showing, and
        // into the URL so the same categories stay hidden across a reload.
        legend: {
          onClick: (evt, legendItem, legend) => {
            const ci = legend.chart;
            const index = legendItem.datasetIndex;
            const hidden = hiddenCategories();
            if (ci.isDatasetVisible(index)) {
              ci.hide(index);
              legendItem.hidden = true;
              hidden.add(stackOrder[index]);
            } else {
              ci.show(index);
              legendItem.hidden = false;
              hidden.delete(stackOrder[index]);
            }
            writeUrl({ hide: [...hidden] });
            renderChartSummary(stackOrder.filter((c) => !hidden.has(c)), totals, labels, groupBy);
          },
        },
      },
    },
  });
}

for (const radio of document.querySelectorAll('input[name="groupby"]')) {
  radio.onchange = () => {
    writeUrl({ group: radio.value });
    renderChart();
  };
}

/* ---------- startup ---------- */

function renderAll() {
  renderStatus();
  renderData();
  renderCategories();
  if (currentPage() === "chart") renderChart();
}

setStatus(transactions.length ? `${transactions.length} transactions loaded` : "");
renderData();
renderCategories();
syncGroupByRadio();
showPage(currentPage(), false);   // renders the chart if that is the active tab
