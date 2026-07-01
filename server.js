import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 4173);

const cache = new Map();
const TTL_MS = 5 * 60 * 1000;
const LONG_TTL_MS = 60 * 60 * 1000;

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < TTL_MS) return hit.value;
  const value = await loader();
  cache.set(key, { time: Date.now(), value });
  return value;
}

async function cachedFor(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.value;
  const value = await loader();
  cache.set(key, { time: Date.now(), value });
  return value;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "GoldMacroDesk/0.1",
        "accept": "text/csv,application/json,text/plain,*/*"
      }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithTimeout(url, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "GoldMacroDesk/0.1",
        "accept": "text/csv,application/json,text/plain,*/*"
      }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(label, loader, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await loader();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  throw new Error(`${label}: ${lastError?.message || lastError}`);
}

function compactSeries(rows) {
  return rows
    .filter((row) => Number.isFinite(row.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function parseFredCsv(csv, id) {
  const lines = csv.trim().split(/\r?\n/);
  const [, ...data] = lines;
  return compactSeries(
    data.map((line) => {
      const [date, raw] = line.split(",");
      const value = raw === "." ? NaN : Number(raw);
      return { date, value };
    })
  ).map((point) => ({ ...point, source: `FRED:${id}` }));
}

function parseYahooChart(json, symbol, transform = (x) => x) {
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(json.chart?.error?.description || "No Yahoo chart result");
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || quote.close || [];
  return compactSeries(
    timestamps.map((time, index) => ({
      date: new Date(time * 1000).toISOString().slice(0, 10),
      value: transform(Number(adj[index])),
      source: `Yahoo:${symbol}`
    }))
  );
}

async function yahooSeries(symbol, range = "2y", transform) {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=${range}&interval=1d&includeAdjustedClose=true`;
  const text = await fetchText(url);
  return parseYahooChart(JSON.parse(text), symbol, transform);
}

async function fredSeries(id) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`;
  return parseFredCsv(await fetchText(url), id);
}

async function fredSeriesLong(id) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`;
  return parseFredCsv(await fetchTextWithTimeout(url, 35000), id);
}

function parseBullionVaultCsv(csv) {
  const month = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12"
  };
  const [, ...rows] = csv.trim().split(/\r?\n/);
  return compactSeries(
    rows.map((line) => {
      const cells = line.split(",").map((cell) => cell.replace(/^"|"$/g, "").trim());
      const match = cells[0]?.match(/(\d{2}):(\d{2}):(\d{2}) (\d{1,2})-([A-Za-z]{3})-(\d{4})/);
      const closeOz = Number(cells[7]);
      if (!match) return { date: "", value: NaN };
      const [, , , , day, mon, year] = match;
      return {
        date: `${year}-${month[mon]}-${day.padStart(2, "0")}`,
        value: closeOz,
        source: "BullionVault:AUX/USD/1y"
      };
    })
  );
}

async function bullionVaultGoldSeries() {
  const url = "https://chart-data.bullionvault.com/prices/CSV/AUX/USD/172800/Full";
  return parseBullionVaultCsv(await fetchText(url));
}

async function worldBankGoldMonthly() {
  const url = "https://raw.githubusercontent.com/datasets/gold-prices/master/data/monthly.csv";
  const csv = await fetchTextWithTimeout(url, 25000);
  const [, ...rows] = csv.trim().split(/\r?\n/);
  return compactSeries(
    rows.map((line) => {
      const [month, raw] = line.split(",");
      return {
        date: `${month}-01`,
        value: Number(raw),
        source: "DataHub/WorldBank:gold-monthly"
      };
    })
  );
}

function monthKey(date) {
  return date.slice(0, 7);
}

function toMonthlyLast(series, sourceLabel) {
  const byMonth = new Map();
  for (const point of series || []) {
    byMonth.set(monthKey(point.date), { date: `${monthKey(point.date)}-01`, value: point.value, source: sourceLabel || point.source });
  }
  return [...byMonth.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function pctChangeAt(series, index, months) {
  if (index - months < 0) return NaN;
  const prev = series[index - months]?.value;
  const now = series[index]?.value;
  if (!Number.isFinite(prev) || !Number.isFinite(now) || prev === 0) return NaN;
  return ((now - prev) / prev) * 100;
}

function diffAt(series, index, months) {
  if (index - months < 0) return NaN;
  const prev = series[index - months]?.value;
  const now = series[index]?.value;
  if (!Number.isFinite(prev) || !Number.isFinite(now)) return NaN;
  return now - prev;
}

function movingAverageAt(values, index, months) {
  if (index - months + 1 < 0) return NaN;
  let sum = 0;
  for (let i = index - months + 1; i <= index; i += 1) sum += values[i].value;
  return sum / months;
}

function maxDrawdown(equityCurve) {
  let peak = equityCurve[0]?.equity || 1;
  let worst = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    worst = Math.min(worst, point.equity / peak - 1);
  }
  return worst;
}

function annualizedReturn(startEquity, endEquity, months) {
  if (months <= 0 || startEquity <= 0 || endEquity <= 0) return 0;
  return Math.pow(endEquity / startEquity, 12 / months) - 1;
}

function scoreHistoricalPanel(row, prevRows, params = {}) {
  const cfg = {
    bull: params.bull ?? 32,
    bear: params.bear ?? -18,
    realSlope: params.realSlope ?? 0.15,
    dollarSlope: params.dollarSlope ?? 1.5
  };
  const factors = { cost: 0, money: 0, insurance: 0, flow: 0 };
  const notes = [];

  if (Number.isFinite(row.realRate6m)) {
    const points = row.realRate6m < -cfg.realSlope ? 24 : row.realRate6m > cfg.realSlope ? -24 : row.realRate6m < 0 ? 10 : -8;
    factors.cost += points;
    notes.push(`实际利率6个月变化${row.realRate6m.toFixed(2)}pct`);
  }
  if (Number.isFinite(row.realRate)) {
    factors.cost += row.realRate < 1.2 ? 10 : row.realRate > 3 ? -12 : 0;
  }
  if (Number.isFinite(row.dollar6m)) {
    const points = row.dollar6m < -cfg.dollarSlope ? 18 : row.dollar6m > cfg.dollarSlope ? -18 : row.dollar6m < 0 ? 7 : -7;
    factors.money += points;
    notes.push(`美元6个月变化${row.dollar6m.toFixed(1)}%`);
  }
  if (Number.isFinite(row.cpiYoY6m)) {
    factors.money += row.cpiYoY6m > 0.3 ? 8 : row.cpiYoY6m < -0.3 ? -8 : 0;
  }
  if (Number.isFinite(row.vix) && Number.isFinite(row.vix3m)) {
    factors.insurance += row.vix > 25 || row.vix3m > 20 ? 8 : row.vix < 14 ? -5 : 0;
  }
  if (Number.isFinite(row.gold) && Number.isFinite(row.goldSma10) && Number.isFinite(row.goldSma40)) {
    factors.flow += row.gold > row.goldSma10 && row.goldSma10 > row.goldSma40 ? 20 : row.gold < row.goldSma10 && row.goldSma10 < row.goldSma40 ? -20 : 0;
  }
  if (Number.isFinite(row.gold6m)) {
    factors.flow += row.gold6m > 6 ? 8 : row.gold6m < -6 ? -8 : 0;
  }

  let score = factors.cost + factors.money + factors.insurance + factors.flow;
  const hasMacro = Number.isFinite(row.realRate) || Number.isFinite(row.dollar6m);
  if (!hasMacro && row.date < "1971-08-01") {
    score = Math.min(score, 0);
    notes.push("布雷顿森林固定金价期，禁止把固定价误判为趋势信号");
  }
  const level = score >= cfg.bull ? "bull" : score <= cfg.bear ? "bear" : "neutral";
  return { score, level, factors, notes };
}

function runBacktest(panel, params = {}) {
  const leverage = params.leverage ?? 2.5;
  const risk = params.risk ?? 0.015;
  const startIndex = panel.findIndex((row) => row.date >= "1966-01-01" && Number.isFinite(row.goldSma40));
  const equityCurve = [];
  const trades = [];
  let equity = 1;
  let active = null;
  let wins = 0;
  let losses = 0;
  let worstTrade = null;
  let missedUps = [];
  let falseLongs = [];

  for (let i = Math.max(0, startIndex); i < panel.length - 1; i += 1) {
    const row = panel[i];
    const next = panel[i + 1];
    if (!Number.isFinite(row.gold) || !Number.isFinite(next.gold)) continue;
    const signal = scoreHistoricalPanel(row, panel.slice(0, i + 1), params);
    const goldReturn = next.gold / row.gold - 1;
    let exposure = 0;
    if (signal.level === "bull") exposure = Math.min(1.25, leverage * 0.35);
    if (signal.level === "neutral") exposure = Math.min(0.45, leverage * 0.12);
    const stopPct = signal.level === "bull" ? 0.075 : 0.05;
    const stopped = exposure > 0 && goldReturn < -stopPct;
    const modelReturn = exposure * (stopped ? -stopPct : goldReturn);
    const prevEquity = equity;
    equity *= 1 + modelReturn;
    equityCurve.push({ date: next.date, equity, signal: signal.level, score: signal.score, gold: next.gold });

    if (signal.level === "bull" && !active) {
      active = { entryDate: next.date, entryGold: next.gold, entryEquity: prevEquity, score: signal.score };
    }
    if (active && signal.level !== "bull") {
      const tradeReturn = prevEquity / active.entryEquity - 1;
      const trade = { ...active, exitDate: next.date, exitGold: next.gold, return: tradeReturn };
      trades.push(trade);
      if (tradeReturn >= 0) wins += 1;
      else losses += 1;
      if (!worstTrade || tradeReturn < worstTrade.return) worstTrade = trade;
      active = null;
    }

    if (signal.level !== "bull" && goldReturn > 0.08) missedUps.push({ date: next.date, goldReturn, score: signal.score, level: signal.level });
    if (signal.level === "bull" && goldReturn < -0.08) falseLongs.push({ date: next.date, goldReturn, score: signal.score });
  }

  const months = equityCurve.length;
  const endEquity = equityCurve.at(-1)?.equity || 1;
  const bhStart = panel[Math.max(0, startIndex)]?.gold || 1;
  const bhEnd = panel.at(-1)?.gold || bhStart;
  return {
    params: { leverage, risk, bull: params.bull ?? 32, bear: params.bear ?? -18 },
    start: equityCurve[0]?.date,
    end: equityCurve.at(-1)?.date,
    months,
    endEquity,
    cagr: annualizedReturn(1, endEquity, months),
    maxDrawdown: maxDrawdown(equityCurve),
    buyHoldReturn: bhEnd / bhStart - 1,
    trades: trades.length,
    winRate: trades.length ? wins / trades.length : 0,
    worstTrade,
    falseLongs: falseLongs.sort((a, b) => a.goldReturn - b.goldReturn).slice(0, 5),
    missedUps: missedUps.sort((a, b) => b.goldReturn - a.goldReturn).slice(0, 5),
    equityCurve
  };
}

function summarizeRegimes(panel, result) {
  const regimes = [
    ["1966-01-01", "1971-08-01", "固定汇率遗留期"],
    ["1971-09-01", "1980-12-01", "通胀失锚与黄金重估"],
    ["1981-01-01", "2000-12-01", "沃尔克后高实际利率"],
    ["2001-01-01", "2011-12-01", "美元走弱与危机再定价"],
    ["2012-01-01", "2015-12-01", "实际利率回升"],
    ["2016-01-01", "2019-12-01", "低利率震荡"],
    ["2020-01-01", "2020-12-01", "疫情冲击"],
    ["2021-01-01", "2022-12-01", "快速加息"],
    ["2023-01-01", "2026-12-01", "财政信用与央行买盘"]
  ];
  const eqByDate = new Map(result.equityCurve.map((p) => [p.date, p.equity]));
  return regimes.map(([start, end, name]) => {
    const rows = result.equityCurve.filter((p) => p.date >= start && p.date <= end);
    const goldRows = panel.filter((p) => p.date >= start && p.date <= end && Number.isFinite(p.gold));
    if (rows.length < 2 || goldRows.length < 2) return { name, start, end, months: rows.length, modelReturn: null, goldReturn: null };
    return {
      name,
      start,
      end,
      months: rows.length,
      modelReturn: rows.at(-1).equity / rows[0].equity - 1,
      goldReturn: goldRows.at(-1).gold / goldRows[0].gold - 1,
      maxDrawdown: maxDrawdown(rows.map((p) => ({ ...p, equity: p.equity / rows[0].equity })))
    };
  });
}

function adversarialChecks(panel) {
  const base = runBacktest(panel);
  const variants = [
    ["更严格入场", { bull: 42 }],
    ["更宽松入场", { bull: 24 }],
    ["更敏感实际利率", { realSlope: 0.08 }],
    ["更钝化美元因子", { dollarSlope: 2.5 }],
    ["高杠杆5x", { leverage: 5 }],
    ["低杠杆2x", { leverage: 2 }]
  ].map(([name, params]) => ({ name, ...runBacktest(panel, params), equityCurve: undefined }));

  const cagrValues = variants.map((v) => v.cagr).filter(Number.isFinite);
  const drawdowns = variants.map((v) => v.maxDrawdown).filter(Number.isFinite);
  const alerts = [];
  if (base.maxDrawdown < -0.35) alerts.push("基础模型最大回撤超过35%，杠杆仓位必须继续收缩。");
  if (variants.find((v) => v.name === "高杠杆5x")?.maxDrawdown < -0.5) alerts.push("5倍杠杆在历史扰动下回撤过深，只能作为小仓趋势确认工具。");
  if (Math.max(...cagrValues) - Math.min(...cagrValues) > 0.08) alerts.push("参数扰动后CAGR差异较大，模型不能过度依赖单一阈值。");
  if (base.falseLongs.length) alerts.push(`最坏做多反例出现在${base.falseLongs[0].date}，单月黄金约${(base.falseLongs[0].goldReturn * 100).toFixed(1)}%。`);
  if (base.missedUps.length) alerts.push(`最大踏空反例出现在${base.missedUps[0].date}，非多头状态下黄金约+${(base.missedUps[0].goldReturn * 100).toFixed(1)}%。`);

  return {
    base: { ...base, equityCurve: base.equityCurve.slice(-360) },
    variants,
    regimes: summarizeRegimes(panel, base),
    alerts,
    robustness: {
      cagrMin: Math.min(...cagrValues),
      cagrMax: Math.max(...cagrValues),
      worstDrawdown: Math.min(...drawdowns)
    }
  };
}

async function loadBacktest() {
  const tasks = {
    gold: () => withRetry("gold monthly history", worldBankGoldMonthly),
    nominal10y: () => withRetry("FRED DGS10", () => fredSeriesLong("DGS10")),
    cpi: () => withRetry("FRED CPIAUCSL", () => fredSeriesLong("CPIAUCSL")),
    dollar: async () => {
      try {
        return await withRetry("FRED TWEXBMTH", () => fredSeriesLong("TWEXBMTH"), 2);
      } catch {
        return withRetry("FRED DTWEXBGS", () => fredSeriesLong("DTWEXBGS"), 2);
      }
    },
    vix: () => withRetry("FRED VIXCLS", () => fredSeriesLong("VIXCLS"))
  };
  const settled = await Promise.allSettled(Object.entries(tasks).map(async ([name, task]) => [name, await task()]));
  const raw = {};
  const errors = [];
  for (const result of settled) {
    if (result.status === "fulfilled") raw[result.value[0]] = result.value[1];
    else errors.push(`${result.reason?.message || String(result.reason)}`);
  }

  const gold = (raw.gold || []).filter((p) => p.date >= "1966-01-01");
  if (gold.length < 600) {
    throw new Error(`Gold monthly history unavailable: ${gold.length} months. ${errors.join("; ")}`);
  }
  const months = gold.map((p) => p.date);
  const monthly = {
    nominal10y: toMonthlyLast(raw.nominal10y, "FRED:DGS10"),
    cpi: toMonthlyLast(raw.cpi, "FRED:CPIAUCSL"),
    dollar: toMonthlyLast(raw.dollar, raw.dollar?.[0]?.source || "FRED:TWEX"),
    vix: toMonthlyLast(raw.vix, "FRED:VIXCLS")
  };
  const maps = Object.fromEntries(Object.entries(monthly).map(([key, series]) => [key, new Map(series.map((p) => [monthKey(p.date), p.value]))]));
  const goldMap = new Map(gold.map((p) => [monthKey(p.date), p.value]));
  const goldRows = months.map((date) => ({ date, value: goldMap.get(monthKey(date)) }));

  const panel = months.map((date, index) => {
    const key = monthKey(date);
    const cpi = maps.cpi.get(key);
    const cpi12 = index >= 12 ? maps.cpi.get(monthKey(months[index - 12])) : NaN;
    const cpiYoY = Number.isFinite(cpi) && Number.isFinite(cpi12) ? ((cpi - cpi12) / cpi12) * 100 : NaN;
    const nominal10y = maps.nominal10y.get(key);
    const realRate = Number.isFinite(nominal10y) && Number.isFinite(cpiYoY) ? nominal10y - cpiYoY : NaN;
    const prevReal = index >= 6 ? null : null;
    return {
      date,
      gold: goldRows[index].value,
      gold6m: pctChangeAt(goldRows, index, 6),
      goldSma10: movingAverageAt(goldRows, index, 10),
      goldSma40: movingAverageAt(goldRows, index, 40),
      nominal10y,
      cpiYoY,
      cpiYoY6m: NaN,
      realRate,
      realRate6m: NaN,
      dollar: maps.dollar.get(key),
      dollar6m: NaN,
      vix: maps.vix.get(key),
      vix3m: NaN
    };
  });

  for (let i = 0; i < panel.length; i += 1) {
    if (i >= 6) {
      if (Number.isFinite(panel[i].realRate) && Number.isFinite(panel[i - 6].realRate)) panel[i].realRate6m = panel[i].realRate - panel[i - 6].realRate;
      if (Number.isFinite(panel[i].cpiYoY) && Number.isFinite(panel[i - 6].cpiYoY)) panel[i].cpiYoY6m = panel[i].cpiYoY - panel[i - 6].cpiYoY;
      if (Number.isFinite(panel[i].dollar) && Number.isFinite(panel[i - 6].dollar)) panel[i].dollar6m = ((panel[i].dollar - panel[i - 6].dollar) / panel[i - 6].dollar) * 100;
    }
    if (i >= 3 && Number.isFinite(panel[i].vix) && Number.isFinite(panel[i - 3].vix)) panel[i].vix3m = ((panel[i].vix - panel[i - 3].vix) / panel[i - 3].vix) * 100;
  }

  if (panel.length < 600) {
    throw new Error(`Historical backtest panel is incomplete: ${panel.length} months`);
  }

  return {
    asOf: new Date().toISOString(),
    dataSources: [
      "Gold monthly: DataHub gold-prices, 1960 onward sourced from World Bank Commodity Markets portal",
      "Rates/CPI/USD/VIX: FRED DGS10, CPIAUCSL, TWEXBMTH or DTWEXBGS, VIXCLS"
    ],
    panelStart: panel[0]?.date,
    panelEnd: panel.at(-1)?.date,
    panelMonths: panel.length,
    errors,
    audit: adversarialChecks(panel)
  };
}

function latest(series) {
  return series?.at(-1) || null;
}

async function loadDashboard() {
  const tasks = {
    gold: () => bullionVaultGoldSeries(),
    dxy: () => fredSeries("DTWEXBGS"),
    nominal10y: () => fredSeries("DGS10"),
    vix: () => fredSeries("VIXCLS"),
    real10y: () => fredSeries("DFII10"),
    breakeven10y: () => fredSeries("T10YIE")
  };

  const settled = await Promise.allSettled(
    Object.entries(tasks).map(async ([name, task]) => [name, await task()])
  );

  const data = {};
  const errors = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      const [name, value] = result.value;
      data[name] = value;
    } else {
      errors.push(result.reason?.message || String(result.reason));
    }
  }

  if (!data.real10y && data.nominal10y && data.breakeven10y) {
    const breakevenByDate = new Map(data.breakeven10y.map((p) => [p.date, p.value]));
    data.real10y = compactSeries(
      data.nominal10y.map((p) => ({
        date: p.date,
        value: p.value - (breakevenByDate.get(p.date) ?? NaN),
        source: "Proxy: ^TNX - FRED:T10YIE"
      }))
    );
  }

  if (data.spotGold?.length) {
    data.gold = data.spotGold;
  }
  delete data.spotGold;
  return {
    asOf: new Date().toISOString(),
    data,
    latest: Object.fromEntries(
      Object.entries(data)
        .filter(([, value]) => Array.isArray(value) && value.length)
        .map(([key, value]) => [key, latest(value)])
    ),
    errors
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  };
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, service: "gold-price-logic-desk", asOf: new Date().toISOString() });
      return;
    }
    if (url.pathname === "/api/market") {
      const force = url.searchParams.get("force") === "1";
      if (force) cache.delete("dashboard");
      const payload = await cached("dashboard", loadDashboard);
      sendJson(res, 200, payload);
      return;
    }
    if (url.pathname === "/api/backtest") {
      const force = url.searchParams.get("force") === "1";
      if (force) cache.delete("backtest");
      const payload = await cachedFor("backtest", LONG_TTL_MS, loadBacktest);
      sendJson(res, 200, payload);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || String(error) });
  }
});

server.listen(port, () => {
  console.log(`Gold Macro Desk running at http://localhost:${port}`);
});
