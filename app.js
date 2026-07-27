"use strict";

const DEFAULT_CATEGORIES = ["Rent", "Food", "Clothes", "Car"];
const UNCATEGORIZED = "Uncategorized";

let transactions = load("cc.transactions", []);
let categories = load("cc.categories", DEFAULT_CATEGORIES);
let assignments = load("cc.assignments", {});   // type -> category

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
// turns a bank-specific row into the generic {date, type, description, amount}.
const BANK_PARSERS = [
  {
    name: "Swedbank",
    matches: (header) => header.includes("Bokföringsdatum") && header.includes("Belopp"),
    parse: (row, header) => {
      const col = (name) => row[header.indexOf(name)];
      const description = (col("Text") || "").trim();
      return {
        date: (col("Bokföringsdatum") || "").trim(),
        type: inferTypeSwedbank(description),
        description,
        amount: parseAmount(col("Belopp")),
      };
    },
  },
];

// "MAXI ICA STO/26-07-13" -> "MAXI ICA STO", but "APPLE COM/BI" keeps its slash
// because it is not followed by a date.
function inferTypeSwedbank(description) {
  return description.replace(/\/\d{2}-\d{2}-\d{2}\s*$/, "").trim();
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

  return lines.slice(1)
    .map((line) => parser.parse(splitCsvLine(line), header))
    .filter((t) => t.date);
}

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
  const filtered = rangeId !== "all" && transactions.length > 0;
  statusEl.textContent = filtered ? `${statusBase} (${shown} in range)` : statusBase;
  dropBtn.hidden = transactions.length === 0;
  rangeEl.hidden = transactions.length === 0;
}

document.getElementById("load-btn").onclick = () =>
  document.getElementById("file-input").click();

// Only drops the transactions; categories and their assignments are kept so a
// freshly loaded statement lands in the categories already set up.
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
      transactions = parseCsv(reader.result);
      save("cc.transactions", transactions);
      setStatus(`${transactions.length} transactions from ${file.name}`);
      renderAll();
    } catch (err) {
      setStatus("Error: " + err.message);
    }
  };
  reader.readAsText(file, "utf-8");
  e.target.value = "";   // let the same file be picked again
};

/* ---------- date range filter ---------- */

// Ranges are relative to today and expressed as an inclusive ISO start date, so
// they can be compared against the transaction dates as plain strings.
const RANGES = [
  { id: "all", label: "All", start: () => null },
  { id: "5y", label: "Last 5 years", start: () => backTo(5, 0) },
  { id: "3y", label: "Last 3 years", start: () => backTo(3, 0) },
  { id: "2y", label: "Last 2 years", start: () => backTo(2, 0) },
  { id: "1y", label: "Last 1 year", start: () => backTo(1, 0) },
  { id: "ytd", label: "Year to date", start: () => isoDate(new Date(new Date().getFullYear(), 0, 1)) },
  { id: "3m", label: "Last 3 months", start: () => backTo(0, 3) },
  { id: "6m", label: "Last 6 months", start: () => backTo(0, 6) },
  { id: "1m", label: "Last month", start: () => backTo(0, 1) },
];

function isoDate(d) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

// Clamps the day so that going back from e.g. the 31st lands on the last day of
// a shorter month rather than spilling into the next one.
function backTo(years, months) {
  const today = new Date();
  const target = new Date(today.getFullYear() - years, today.getMonth() - months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(today.getDate(), lastDay));
  return isoDate(target);
}

let rangeId = load("cc.range", "all");
if (!RANGES.some((r) => r.id === rangeId)) rangeId = "all";

const rangeEl = document.getElementById("range");
for (const r of RANGES) rangeEl.add(new Option(r.label, r.id));
rangeEl.value = rangeId;

rangeEl.onchange = () => {
  rangeId = rangeEl.value;
  save("cc.range", rangeId);
  renderAll();
};

// Every tab renders from this rather than from `transactions` directly.
function visible() {
  const start = RANGES.find((r) => r.id === rangeId).start();
  return start === null ? transactions : transactions.filter((t) => t.date >= start);
}

/* ---------- tabs ---------- */

const PAGES = ["data", "categories", "chart"];

function currentPage() {
  const page = new URLSearchParams(location.search).get("page");
  return PAGES.includes(page) ? page : "data";
}

function showPage(page, push) {
  for (const p of PAGES) {
    document.getElementById("page-" + p).classList.toggle("active", p === page);
  }
  for (const btn of document.querySelectorAll("#tabs button")) {
    btn.classList.toggle("active", btn.dataset.page === page);
  }
  if (push) {
    const url = new URL(location);
    url.searchParams.set("page", page);
    history.pushState({}, "", url);
  }
  if (page === "chart") renderChart();   // canvas needs to be visible to size itself
}

for (const btn of document.querySelectorAll("#tabs button")) {
  btn.onclick = () => showPage(btn.dataset.page, true);
}
window.onpopstate = () => showPage(currentPage(), false);

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

const kronor = (n) => n.toLocaleString("sv-SE", { maximumFractionDigits: 2 });

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
  for (const t of sortRows(rows, dataSort)) {
    const tr = tbody.insertRow();
    tr.insertCell().textContent = t.date;
    tr.insertCell().textContent = t.type;
    tr.insertCell().textContent = t.description;
    const amount = tr.insertCell();
    amount.textContent = kronor(t.amount);
    amount.className = "amount" + (t.amount < 0 ? " negative" : "");
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
    total.className = "amount";

    const select = document.createElement("select");
    select.add(new Option("—", ""));
    for (const cat of categories) select.add(new Option(cat, cat));
    select.value = assignments[row.type] || "";
    select.onchange = () => {
      if (select.value) assignments[row.type] = select.value;
      else delete assignments[row.type];
      save("cc.assignments", assignments);
    };
    tr.insertCell().appendChild(select);
  }
}

bindSorting(document.getElementById("types-table"), typeSort, renderCategories);

document.getElementById("add-category").onclick = () => {
  const input = document.getElementById("new-category");
  const name = input.value.trim();
  if (name && !categories.includes(name)) {
    categories.push(name);
    save("cc.categories", categories);
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

function selectedGroupBy() {
  return document.querySelector('input[name="groupby"]:checked').value;
}

// Distinct hues, so neighbouring stack layers stay tellable apart.
const color = (i) => `hsl(${(i * 137.5) % 360}, 65%, 55%)`;

function renderChart() {
  const empty = document.getElementById("chart-empty");
  const canvas = document.getElementById("chart");
  const rows = visible();
  empty.hidden = rows.length > 0;
  canvas.hidden = rows.length === 0;
  if (!rows.length) {
    setEmptyMessage(empty);
    if (chart) { chart.destroy(); chart = null; }
    return;
  }

  const groupBy = selectedGroupBy();
  const totals = new Map();       // bucket -> category -> cost
  const usedCategories = new Set();

  for (const t of rows) {
    if (t.amount >= 0) continue;  // costs only
    const bucket = bucketOf(t.date, groupBy);
    const category = assignments[t.type] || UNCATEGORIZED;
    if (!totals.has(bucket)) totals.set(bucket, new Map());
    const row = totals.get(bucket);
    row.set(category, (row.get(category) || 0) + -t.amount);
    usedCategories.add(category);
  }

  const labels = [...totals.keys()].sort();
  const stackOrder = categories.filter((c) => usedCategories.has(c));
  if (usedCategories.has(UNCATEGORIZED)) stackOrder.push(UNCATEGORIZED);

  // Colour by position in `categories` so a category keeps its colour even as
  // other categories appear and disappear from the stack.
  const datasets = stackOrder.map((category) => ({
    label: category,
    data: labels.map((b) => totals.get(b).get(category) || 0),
    backgroundColor: category === UNCATEGORIZED ? "#bbb" : color(categories.indexOf(category)),
  }));

  if (chart) chart.destroy();
  chart = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true },
        y: { stacked: true, title: { display: true, text: "kronor" } },
      },
      plugins: {
        tooltip: {
          callbacks: { label: (c) => `${c.dataset.label}: ${kronor(c.parsed.y)} kr` },
        },
      },
    },
  });
}

for (const radio of document.querySelectorAll('input[name="groupby"]')) {
  radio.onchange = renderChart;
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
showPage(currentPage(), false);   // renders the chart if that is the active tab
