const state = {
  payload: null,
  backtest: null,
  chartMode: "gold"
};

const ids = [
  "refreshBtn",
  "autoRefresh",
  "goldPrice",
  "goldMeta",
  "realYield",
  "realYieldTrend",
  "dxy",
  "dxyTrend",
  "score",
  "scoreLabel",
  "costScore",
  "moneyScore",
  "insuranceScore",
  "flowScore",
  "equity",
  "riskPct",
  "leverage",
  "leverageOut",
  "horizon",
  "manualGold",
  "chartMode",
  "mainChart",
  "decision",
  "direction",
  "position",
  "stopLoss",
  "target",
  "drivers",
  "updatedAt",
  "statusRows",
  "backtestBtn",
  "auditMeta",
  "btCagr",
  "btDrawdown",
  "btTrades",
  "btBuyHold",
  "backtestChart",
  "auditAlerts",
  "regimeRows"
];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

const names = {
  gold: "黄金",
  real10y: "10年实际利率",
  dxy: "美元指数",
  nominal10y: "10年名义利率",
  breakeven10y: "10年通胀预期",
  vix: "VIX"
};

const fmt = {
  usd: (v) => (Number.isFinite(v) ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}` : "--"),
  pct: (v) => (Number.isFinite(v) ? `${v.toFixed(2)}%` : "--"),
  pct0: (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "--"),
  num: (v) => (Number.isFinite(v) ? v.toFixed(2) : "--"),
  score: (v) => (v > 0 ? `+${v}` : String(v))
};

function latest(series) {
  return series?.at(-1) || null;
}

function valueDaysAgo(series, days) {
  if (!series?.length) return null;
  const target = new Date(series.at(-1).date);
  target.setDate(target.getDate() - days);
  const targetKey = target.toISOString().slice(0, 10);
  return [...series].reverse().find((p) => p.date <= targetKey) || series[0];
}

function sma(series, length) {
  if (!series || series.length < length) return NaN;
  const slice = series.slice(-length);
  return slice.reduce((sum, p) => sum + p.value, 0) / slice.length;
}

function pctChange(series, days) {
  const now = latest(series);
  const prev = valueDaysAgo(series, days);
  if (!now || !prev || !prev.value) return NaN;
  return ((now.value - prev.value) / prev.value) * 100;
}

function absChange(series, days) {
  const now = latest(series);
  const prev = valueDaysAgo(series, days);
  if (!now || !prev) return NaN;
  return now.value - prev.value;
}

function recentLow(series, lookback = 45) {
  const slice = series?.slice(-lookback) || [];
  return slice.reduce((min, p) => Math.min(min, p.value), Infinity);
}

function recentHigh(series, lookback = 80) {
  const slice = series?.slice(-lookback) || [];
  return slice.reduce((max, p) => Math.max(max, p.value), -Infinity);
}

function calculateSignal(data) {
  const gold = data.gold || [];
  const goldNow = Number(els.manualGold.value) || latest(gold)?.value;
  const realNow = latest(data.real10y)?.value;
  const vixNow = latest(data.vix)?.value;
  const real60 = absChange(data.real10y, 60);
  const breakeven60 = absChange(data.breakeven10y, 60);
  const dxy60 = pctChange(data.dxy, 60);
  const gold60 = pctChange(gold, 60);
  const gold200 = sma(gold, 200);
  const gold50 = sma(gold, 50);
  const vix20 = pctChange(data.vix, 20);
  const factors = {
    cost: { score: 0, label: "机会成本" },
    money: { score: 0, label: "货币信用" },
    insurance: { score: 0, label: "保险价值" },
    flow: { score: 0, label: "边际买盘" }
  };
  const drivers = [];

  if (Number.isFinite(real60)) {
    const points = real60 < -0.15 ? 24 : real60 > 0.15 ? -24 : real60 < 0 ? 10 : -8;
    factors.cost.score += points;
    drivers.push(`机会成本：10年实际利率60天变化 ${real60.toFixed(2)}pct，持有黄金的相对代价${points > 0 ? "下降" : "上升"}。`);
  }
  if (Number.isFinite(realNow)) {
    const points = realNow < 1.6 ? 10 : realNow > 2.2 ? -12 : 0;
    factors.cost.score += points;
    drivers.push(`机会成本：实际利率水平 ${realNow.toFixed(2)}%，无息资产的机会成本${points >= 0 ? "可控" : "偏高"}。`);
  }
  if (Number.isFinite(dxy60)) {
    const points = dxy60 < -1.5 ? 18 : dxy60 > 1.5 ? -18 : dxy60 < 0 ? 7 : -7;
    factors.money.score += points;
    drivers.push(`货币信用：美元指数60天变化 ${dxy60.toFixed(1)}%，美元${points > 0 ? "走弱提高黄金替代需求" : "走强压制美元计价金价"}。`);
  }
  if (Number.isFinite(breakeven60)) {
    const points = breakeven60 > 0.12 ? 8 : breakeven60 < -0.12 ? -8 : 0;
    factors.money.score += points;
    drivers.push(`货币信用：10年通胀预期60天变化 ${breakeven60.toFixed(2)}pct，购买力担忧${points > 0 ? "上升" : points < 0 ? "降温" : "变化不大"}。`);
  }
  if (Number.isFinite(goldNow) && Number.isFinite(gold50) && Number.isFinite(gold200)) {
    const points = goldNow > gold50 && gold50 > gold200 ? 20 : goldNow < gold50 && gold50 < gold200 ? -20 : 0;
    factors.flow.score += points;
    drivers.push(`边际买盘：价格相对50/200日均线呈${points > 0 ? "多头排列" : points < 0 ? "空头排列" : "混合结构"}。`);
  }
  if (Number.isFinite(gold60)) {
    const points = gold60 > 6 ? 8 : gold60 < -6 ? -8 : 0;
    factors.flow.score += points;
    drivers.push(`边际买盘：黄金60天动量 ${gold60.toFixed(1)}%，${points > 0 ? "趋势惯性仍在" : points < 0 ? "需要防守" : "动量中性"}。`);
  }
  if (Number.isFinite(vixNow) && Number.isFinite(vix20)) {
    const points = vixNow > 22 || vix20 > 20 ? 8 : vixNow < 14 ? -5 : 0;
    factors.insurance.score += points;
    drivers.push(`保险价值：VIX ${vixNow.toFixed(1)}，尾部风险保护需求${points > 0 ? "上升" : points < 0 ? "偏弱" : "中性"}。`);
  }

  const score = Object.values(factors).reduce((sum, item) => sum + item.score, 0);
  const level = score >= 35 ? "bull" : score <= -18 ? "bear" : "neutral";
  const label = level === "bull" ? "做多窗口" : level === "bear" ? "防守/偏空" : "等待确认";
  return { score: Math.round(score), label, level, goldNow, drivers, factors };
}

function buildPlan(signal, data) {
  const equity = Number(els.equity.value) || 10000;
  const riskPct = Math.min(5, Math.max(0.1, Number(els.riskPct.value) || 1));
  const leverage = Number(els.leverage.value) || 2;
  const horizon = els.horizon.value;
  const gold = data.gold || [];
  const price = signal.goldNow;
  const low = recentLow(gold, horizon === "swing" ? 35 : 70);
  const high = recentHigh(gold, 90);
  let stop;
  let target;
  let exposurePct;
  let direction;
  let decision;

  if (signal.level === "bull") {
    direction = "分批做多";
    stop = Math.min(price * 0.94, low * 0.992);
    target = `${fmt.usd(Math.max(high * 1.03, price * 1.08))} / ${fmt.usd(price * 1.16)}`;
    exposurePct = leverage <= 3 ? 35 : 20;
    decision = "宏观价格逻辑与边际买盘共振偏多。适合等回踩不破或突破确认后分批进场，禁止一次性满杠杆。";
  } else if (signal.level === "bear") {
    direction = "不抄底";
    stop = price * 1.045;
    target = `${fmt.usd(price * 0.94)} / ${fmt.usd(price * 0.88)}`;
    exposurePct = 0;
    decision = "机会成本、货币信用或边际买盘偏压制。中期账户以现金/观望为主，已有多单应降杠杆并看硬止损。";
  } else {
    direction = "观察/试探";
    stop = Math.min(price * 0.955, low * 0.995);
    target = `${fmt.usd(price * 1.06)} / ${fmt.usd(price * 1.11)}`;
    exposurePct = leverage <= 2.5 ? 15 : 8;
    decision = "信号不够干净。若必须参与，只适合小仓试探，等实际利率下行或价格站上关键均线后再加。";
  }

  const riskDollars = equity * (riskPct / 100);
  const riskPerOz = Math.abs(price - stop);
  const maxOzByRisk = riskPerOz > 0 ? riskDollars / riskPerOz : 0;
  const maxOzByMargin = (equity * (exposurePct / 100) * leverage) / price;
  const suggestedOz = Math.max(0, Math.min(maxOzByRisk, maxOzByMargin));
  const margin = leverage ? (suggestedOz * price) / leverage : 0;

  return { direction, decision, stop, target, suggestedOz, margin };
}

function drawLineChart(canvas, series, valueKey = "value", color = "#b8872f") {
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * ratio);
  canvas.height = Math.floor(rect.height * ratio);
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const pad = { left: 58, right: 18, top: 18, bottom: 34 };
  const points = (series || []).filter((p) => Number.isFinite(p[valueKey])).slice(-520);
  if (points.length < 2) {
    ctx.fillStyle = "#62706b";
    ctx.fillText("暂无数据", 24, 32);
    return;
  }

  const values = points.map((p) => p[valueKey]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const x = (i) => pad.left + (i / (points.length - 1)) * (rect.width - pad.left - pad.right);
  const y = (v) => pad.top + ((max - v) / range) * (rect.height - pad.top - pad.bottom);

  ctx.strokeStyle = "#d8dfd7";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const yy = pad.top + (i / 4) * (rect.height - pad.top - pad.bottom);
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(rect.width - pad.right, yy);
    ctx.stroke();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  points.forEach((p, i) => {
    const xx = x(i);
    const yy = y(p[valueKey]);
    if (i === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  ctx.stroke();

  ctx.fillStyle = "#62706b";
  ctx.font = "12px Segoe UI, Arial";
  [min, min + range / 2, max].forEach((v) => ctx.fillText(v.toFixed(2), 8, y(v) + 4));
  ctx.fillText(points[0].date, pad.left, rect.height - 10);
  ctx.fillText(points.at(-1).date, rect.width - 96, rect.height - 10);
}

function renderMarket() {
  if (!state.payload) return;
  const { data } = state.payload;
  const signal = calculateSignal(data);
  const plan = buildPlan(signal, data);
  const goldPoint = latest(data.gold);
  const realPoint = latest(data.real10y);
  const dxyPoint = latest(data.dxy);

  els.goldPrice.textContent = fmt.usd(signal.goldNow);
  els.goldMeta.textContent = goldPoint ? `${goldPoint.date} · ${goldPoint.source}` : "无数据";
  els.realYield.textContent = fmt.pct(realPoint?.value);
  els.realYieldTrend.textContent = `60天 ${fmt.pct(absChange(data.real10y, 60))}`;
  els.dxy.textContent = fmt.num(dxyPoint?.value);
  els.dxyTrend.textContent = `60天 ${fmt.pct(pctChange(data.dxy, 60))}`;
  els.score.textContent = signal.score;
  els.score.className = signal.level;
  els.scoreLabel.textContent = signal.label;
  els.costScore.textContent = fmt.score(signal.factors.cost.score);
  els.moneyScore.textContent = fmt.score(signal.factors.money.score);
  els.insuranceScore.textContent = fmt.score(signal.factors.insurance.score);
  els.flowScore.textContent = fmt.score(signal.factors.flow.score);
  els.decision.textContent = plan.decision;
  els.direction.textContent = plan.direction;
  els.position.textContent = `${plan.suggestedOz.toFixed(2)} oz · 保证金${fmt.usd(plan.margin)}`;
  els.stopLoss.textContent = fmt.usd(plan.stop);
  els.target.textContent = plan.target;
  els.drivers.innerHTML = signal.drivers.map((d) => `<li>${d}</li>`).join("");
  els.updatedAt.textContent = `刷新于 ${new Date(state.payload.asOf).toLocaleString()}`;
  els.statusRows.innerHTML = Object.entries(data)
    .filter(([, series]) => series?.length)
    .map(([key, series]) => {
      const point = latest(series);
      const value = key.includes("10y") || key.includes("breakeven") ? fmt.pct(point.value) : fmt.num(point.value);
      return `<div class="status"><span>${names[key] || key}</span><strong>${value}</strong><span>${point.date} · ${point.source}</span></div>`;
    })
    .join("");
  drawLineChart(els.mainChart, data[state.chartMode]);
}

function renderBacktest() {
  const bt = state.backtest;
  if (!bt?.audit) return;
  const base = bt.audit.base;
  els.auditMeta.textContent = `${bt.panelStart} 至 ${bt.panelEnd} · ${bt.panelMonths}个月 · 月度信号下一月执行`;
  els.btCagr.textContent = fmt.pct0(base.cagr);
  els.btDrawdown.textContent = fmt.pct0(base.maxDrawdown);
  els.btTrades.textContent = `${base.trades} / ${fmt.pct0(base.winRate)}`;
  els.btBuyHold.textContent = fmt.pct0(base.buyHoldReturn);
  els.auditAlerts.innerHTML = (bt.audit.alerts.length ? bt.audit.alerts : ["暂无严重反例，但这不代表未来有效。"])
    .map((item) => `<li>${item}</li>`)
    .join("");
  els.regimeRows.innerHTML = bt.audit.regimes
    .map((r) => {
      const model = r.modelReturn == null ? "--" : fmt.pct0(r.modelReturn);
      const gold = r.goldReturn == null ? "--" : fmt.pct0(r.goldReturn);
      const dd = r.maxDrawdown == null ? "--" : fmt.pct0(r.maxDrawdown);
      return `<div class="regime"><strong>${r.name}</strong><span>${r.start.slice(0, 7)} - ${r.end.slice(0, 7)}</span><span>模型 ${model} · 黄金 ${gold} · 回撤 ${dd}</span></div>`;
    })
    .join("");
  drawLineChart(els.backtestChart, base.equityCurve, "equity", "#315f8f");
}

async function loadMarket(force = false) {
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = "读取中";
  try {
    const response = await fetch(`/api/market${force ? "?force=1" : ""}`);
    if (!response.ok) throw new Error(await response.text());
    state.payload = await response.json();
    renderMarket();
  } catch (error) {
    els.decision.textContent = `数据读取失败：${error.message || error}`;
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = "刷新";
  }
}

async function loadBacktest(force = false) {
  els.backtestBtn.disabled = true;
  els.backtestBtn.textContent = "回测中";
  try {
    const response = await fetch(`/api/backtest${force ? "?force=1" : ""}`);
    if (!response.ok) throw new Error(await response.text());
    state.backtest = await response.json();
    renderBacktest();
  } catch (error) {
    els.auditMeta.textContent = `回测失败：${error.message || error}`;
  } finally {
    els.backtestBtn.disabled = false;
    els.backtestBtn.textContent = "重测";
  }
}

els.refreshBtn.addEventListener("click", () => loadMarket(true));
els.backtestBtn.addEventListener("click", () => loadBacktest(true));
els.chartMode.addEventListener("change", () => {
  state.chartMode = els.chartMode.value;
  renderMarket();
});
["equity", "riskPct", "leverage", "horizon", "manualGold"].forEach((id) => {
  els[id].addEventListener("input", () => {
    els.leverageOut.textContent = `${Number(els.leverage.value).toFixed(1)}x`;
    renderMarket();
  });
});
window.addEventListener("resize", () => {
  renderMarket();
  renderBacktest();
});
setInterval(() => {
  if (els.autoRefresh.checked) loadMarket(true);
}, 5 * 60 * 1000);

els.leverageOut.textContent = `${Number(els.leverage.value).toFixed(1)}x`;
loadMarket();
loadBacktest();
