const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const ONE_MINUTE = 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;
let marketCache = null;
let flowCache = null;

function loadOptionalModule(name) {
  try {
    return require(name);
  } catch {
    return require(`/Users/chenyilin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/${name}`);
  }
}

const yahooGroups = {
  taiwanIndex: [],
  globalIndex: [],
  safeHaven: [
    ["^VIX", "VIX"],
    ["GC=F", "黃金"],
    ["BZ=F", "布蘭特原油"],
    ["DX-Y.NYB", "美元指數"],
  ],
};

const cmoneyUsFinanceItems = [
  { path: "spx", name: "🇺🇸 S&P 500", ticker: "SPX", pairKey: "sp500" },
  { path: "es", name: "🇺🇸 S&P 500 期貨", ticker: "ES", pairKey: "sp500" },
  { path: "ixic", name: "🇺🇸 Nasdaq", ticker: "IXIC", pairKey: "nasdaq" },
  { path: "nq", name: "🇺🇸 Nasdaq 100 期貨", ticker: "NQ", pairKey: "nasdaq" },
  { path: "dji", name: "🇺🇸 Dow Jones", ticker: "DJI", pairKey: "dow" },
  { path: "ym", name: "🇺🇸 道瓊期貨", ticker: "YM", pairKey: "dow" },
  { path: "sox", name: "🇺🇸 費城半導體", ticker: "SOX", pairKey: "semiconductor" },
];

const tradingViewGlobalIndexItems = [
  { symbol: "TVC:NI225", name: "🇯🇵 日經 225", ticker: "NI225", pairKey: "japan", market: "japan" },
  { symbol: "TSE:TOPIX", name: "🇯🇵 東證指數", ticker: "TOPIX", pairKey: "japan", market: "japan" },
  { symbol: "TVC:KOSPI", name: "🇰🇷 KOSPI", ticker: "KOSPI", pairKey: "korea", market: "korea" },
  { symbol: "KRX:KOSDAQ", name: "🇰🇷 KOSDAQ", ticker: "KOSDAQ", pairKey: "korea", market: "korea" },
];

const configuredPlaceholders = {
  taiwanIndex: [
    { name: "加權指數", ticker: "TWA00", value: null, changePct: null, state: "讀取失敗", source: "CMoney" },
    { name: "櫃買指數", ticker: "TWC00", value: null, changePct: null, state: "讀取失敗", source: "CMoney" },
    { name: "台指期夜盤", ticker: "TXF1", value: null, changePct: null, state: "讀取失敗", source: "CMoney" },
    { name: "富台指", ticker: "TWN", value: null, changePct: null, state: "讀取失敗", source: "HiStock 富台期" },
  ],
};

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function mime(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

function zonedParts(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function zonedMinutes(timeZone, now = new Date()) {
  const parts = zonedParts(timeZone, now);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function isWeekday(parts) {
  return !["Sat", "Sun"].includes(parts.weekday);
}

function isTaiwanEquityOpen(now = new Date()) {
  const parts = zonedParts("Asia/Taipei", now);
  const minutes = zonedMinutes("Asia/Taipei", now);
  return isWeekday(parts) && minutes >= 9 * 60 && minutes <= 13 * 60 + 30;
}

function isJapanEquityOpen(now = new Date()) {
  const parts = zonedParts("Asia/Tokyo", now);
  const minutes = zonedMinutes("Asia/Tokyo", now);
  return isWeekday(parts) && minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}

function isKoreaEquityOpen(now = new Date()) {
  const parts = zonedParts("Asia/Seoul", now);
  const minutes = zonedMinutes("Asia/Seoul", now);
  return isWeekday(parts) && minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}

function isTaiwanFutureOpen(now = new Date()) {
  const parts = zonedParts("Asia/Taipei", now);
  const minutes = zonedMinutes("Asia/Taipei", now);
  if (parts.weekday === "Sun") return false;
  if (parts.weekday === "Sat") return minutes < 5 * 60;
  return minutes >= 8 * 60 + 45 || minutes < 5 * 60;
}

function isSgxTaiwanIndexFutureOpen(now = new Date()) {
  const parts = zonedParts("Asia/Singapore", now);
  const minutes = zonedMinutes("Asia/Singapore", now);
  const beforeMorningClose = minutes < 5 * 60 + 15;
  const daySession = minutes >= 8 * 60 + 45 && minutes <= 13 * 60 + 50;
  const nightSession = minutes >= 14 * 60 + 15;
  if (parts.weekday === "Sun") return false;
  if (parts.weekday === "Sat") return beforeMorningClose;
  if (parts.weekday === "Mon") return daySession || nightSession;
  return beforeMorningClose || daySession || nightSession;
}

function histockMarketStatus(marketType) {
  if (marketType === "sgxTaiwanFuture") {
    return {
      ...closedState(isSgxTaiwanIndexFutureOpen()),
      openState: "夜盤",
    };
  }
  return {
    ...closedState(isTaiwanEquityOpen()),
    openState: null,
  };
}

function isUsYieldOpen(now = new Date()) {
  const parts = zonedParts("America/New_York", now);
  const minutes = zonedMinutes("America/New_York", now);
  return isWeekday(parts) && minutes >= 8 * 60 && minutes <= 17 * 60;
}

function usEquitySession(now = new Date()) {
  const parts = zonedParts("America/New_York", now);
  const minutes = zonedMinutes("America/New_York", now);
  if (!isWeekday(parts)) return "closed";
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "premarket";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "postmarket";
  return "closed";
}

function closedState(isOpen) {
  return isOpen ? null : { state: "休市", marketClosed: true };
}

function isYahooRegularOpen(meta, now = Date.now()) {
  const regular = meta?.currentTradingPeriod?.regular;
  if (!regular?.start || !regular?.end) return meta?.marketState !== "CLOSED";
  const nowSeconds = Math.floor(now / 1000);
  return nowSeconds >= regular.start && nowSeconds <= regular.end;
}

async function fetchYahooQuote(symbol, name, unit = "", pairKey = "") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 market-dashboard" },
  });
  if (!response.ok) throw new Error(`${symbol} ${response.status}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) throw new Error(`${symbol} missing meta`);
  const value = meta.regularMarketPrice ?? meta.previousClose ?? null;
  const previous = meta.previousClose ?? meta.chartPreviousClose ?? null;
  const changePct = value && previous ? ((value - previous) / previous) * 100 : null;
  const isClosed = !isYahooRegularOpen(meta);
  return {
    name,
    ticker: symbol,
    value,
    unit,
    changePct,
    state: isClosed ? "休市" : meta.marketState || "更新",
    marketClosed: isClosed,
    source: "Yahoo Finance",
    pairKey,
    series: yahooSeriesFromResult(result),
  };
}

function parseAmount(value) {
  return Number(String(value).replace(/,/g, ""));
}

function parseDateState(date) {
  if (!date || date.length < 8) return "更新";
  return `${date.slice(4, 6)}/${date.slice(6, 8)}`;
}

function toYi(valueInNtd) {
  return Math.round((valueInNtd / 100000000) * 100) / 100;
}

function flowText(valueInYi) {
  if (valueInYi > 0) return `買超 ${Math.abs(valueInYi).toFixed(2)} 億`;
  if (valueInYi < 0) return `賣超 ${Math.abs(valueInYi).toFixed(2)} 億`;
  return "買賣平衡";
}

function flowTone(valueInYi) {
  if (valueInYi > 0) return "up";
  if (valueInYi < 0) return "down";
  return "flat";
}

function contractText(value) {
  if (value < 0) return `淨空 ${Math.abs(value).toLocaleString("zh-TW")} 口`;
  if (value > 0) return `淨多 ${Math.abs(value).toLocaleString("zh-TW")} 口`;
  return "多空平衡";
}

function contractCompareText(current, previous) {
  const diff = current - previous;
  const sign = diff > 0 ? "+" : "";
  return `較前日 ${sign}${diff.toLocaleString("zh-TW")} 口`;
}

function contractCompareTone(current, previous) {
  const diff = current - previous;
  if (diff > 0) return "down";
  if (diff < 0) return "up";
  return "flat";
}

function quoteText(change, changePct) {
  const changeSign = change > 0 ? "+" : "";
  const changePctSign = changePct > 0 ? "+" : "";
  return `${changeSign}${change.toFixed(2)} / ${changePctSign}${changePct.toFixed(2)}%`;
}

function compactSeries(values, maxPoints = 72) {
  const numericValues = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (numericValues.length < 2) return undefined;
  if (numericValues.length <= maxPoints) return numericValues;
  const step = (numericValues.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => numericValues[Math.round(index * step)]);
}

function chartSeriesFromRows(rows, valueIndex = 1) {
  if (!Array.isArray(rows)) return undefined;
  return compactSeries(rows.map((row) => (Array.isArray(row) ? row[valueIndex] : row?.value ?? row?.close)));
}

function yahooSeriesFromResult(result) {
  const closes = result?.indicators?.quote?.[0]?.close;
  return compactSeries(Array.isArray(closes) ? closes : []);
}

async function fetchYahooSeries(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 market-dashboard" },
  });
  if (!response.ok) throw new Error(`Yahoo series ${symbol} ${response.status}`);
  const result = (await response.json()).chart?.result?.[0];
  const series = yahooSeriesFromResult(result);
  if (!series) throw new Error(`Yahoo series ${symbol} missing`);
  return series;
}

async function attachSupplementalSeries(items, symbolMap) {
  const targets = items
    .map((item, index) => ({ item, index, symbol: symbolMap[item.ticker] || symbolMap[item.name] }))
    .filter(({ item, symbol }) => symbol && !item.series);
  const results = await Promise.allSettled(targets.map(({ symbol }) => fetchYahooSeries(symbol)));
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      items[targets[index].index] = { ...targets[index].item, series: result.value };
    }
  });
  return items;
}

function signedText(value, unit = "") {
  return `${value > 0 ? "+" : ""}${value.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}${unit}`;
}

function withUpdatedAt(items, timestamp) {
  const updatedAt = new Date(timestamp).toISOString();
  return items.map((item) => (
    item.marketClosed ? { ...item, updatedAt: undefined } : { ...item, updatedAt: item.updatedAt || updatedAt }
  ));
}

function cmoneyGraphFromHtml(html) {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  return scripts.flatMap((match) => {
    try {
      const parsed = JSON.parse(match[1]);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      return entries.flatMap((item) => {
        const graph = item["@graph"] || [item];
        return graph.flatMap((entry) => [entry, entry.about].filter(Boolean));
      });
    } catch {
      return [];
    }
  });
}

function cmoneyNuxtDataFromHtml(html) {
  const match = html.match(/<script>window\.__NUXT__=([\s\S]*?)<\/script>/);
  if (!match) throw new Error("CMoney Nuxt data missing");
  const sandbox = { window: {} };
  vm.runInNewContext(`window.__NUXT__=${match[1]}`, sandbox, { timeout: 5000 });
  return sandbox.window.__NUXT__?.data?.[0];
}

function cmoneySeriesFromHtml(html) {
  try {
    const data = cmoneyNuxtDataFromHtml(html);
    return chartSeriesFromRows(data?.trendchartData?.data);
  } catch {
    return undefined;
  }
}

function htmlToLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseSignedNumber(value) {
  const text = String(value).trim();
  const sign = text.includes("▼") ? -1 : 1;
  const number = Number(text.replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? sign * Math.abs(number) : null;
}

function findTwseRow(rows, matcher) {
  const row = rows.find((item) => matcher(item[0]));
  if (!row) throw new Error("TWSE row missing");
  return row;
}

async function fetchTwseInstitutionalFlows() {
  const url = "https://www.twse.com.tw/fund/BFI82U?response=json&type=day";
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 market-dashboard",
    },
  });
  if (!response.ok) throw new Error(`TWSE BFI82U ${response.status}`);
  const payload = await response.json();
  if (!/^ok$/i.test(payload.stat) || !Array.isArray(payload.data)) {
    throw new Error(`TWSE BFI82U ${payload.stat || "invalid"}`);
  }

  const foreign = findTwseRow(payload.data, (name) => name.startsWith("外資及陸資"));
  const investmentTrust = findTwseRow(payload.data, (name) => name === "投信");
  const dealerRows = payload.data.filter((row) => row[0].startsWith("自營商("));
  const dealerNet = dealerRows.reduce((sum, row) => sum + parseAmount(row[3]), 0);
  const foreignNetYi = toYi(parseAmount(foreign[3]));
  const investmentTrustNetYi = toYi(parseAmount(investmentTrust[3]));
  const dealerNetYi = toYi(dealerNet);
  const date = payload.date ? `${payload.date.slice(4, 6)}/${payload.date.slice(6, 8)}` : "盤後";

  return [
    {
      name: "外資買賣超",
      ticker: "上市",
      value: foreignNetYi,
      unit: " 億",
      changePct: null,
      changeText: flowText(foreignNetYi),
      tone: flowTone(foreignNetYi),
      valueTone: flowTone(foreignNetYi),
      hideChange: true,
      state: date,
      source: "TWSE BFI82U",
      refreshRule: "14:45 日更",
      pairKey: "flow-institutional",
    },
    {
      name: "投信買賣超",
      ticker: "上市",
      value: investmentTrustNetYi,
      unit: " 億",
      changePct: null,
      changeText: flowText(investmentTrustNetYi),
      tone: flowTone(investmentTrustNetYi),
      valueTone: flowTone(investmentTrustNetYi),
      hideChange: true,
      state: date,
      source: "TWSE BFI82U",
      refreshRule: "14:45 日更",
      pairKey: "flow-institutional",
    },
    {
      name: "自營商買賣超",
      ticker: "上市",
      value: dealerNetYi,
      unit: " 億",
      changePct: null,
      changeText: flowText(dealerNetYi),
      tone: flowTone(dealerNetYi),
      valueTone: flowTone(dealerNetYi),
      hideChange: true,
      state: date,
      source: "TWSE BFI82U",
      refreshRule: "14:45 日更",
      pairKey: "flow-dealer-public",
    },
  ];
}

async function fetchCmoneyNightFuture() {
  const url = "https://www.cmoney.tw/forum/futures/TXF1?s=p";
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 market-dashboard" },
  });
  if (!response.ok) throw new Error(`CMoney TXF1 ${response.status}`);
  const html = await response.text();
  const graph = cmoneyGraphFromHtml(html);
  const entity = graph.find((item) => item.tickerSymbol === "TXF1");
  if (!entity?.additionalProperty) throw new Error("CMoney TXF1 data missing");
  const props = Object.fromEntries(entity.additionalProperty.map((item) => [item.name, item.value]));
  const value = Number(props["成交"]);
  const change = Number(props["漲跌"]);
  let changePct = Number(props["漲跌幅"]);
  if (Number.isFinite(change) && Number.isFinite(changePct) && change < 0 && changePct > 0) {
    changePct *= -1;
  }
  if (!Number.isFinite(value)) throw new Error("CMoney TXF1 price missing");
  const closeInfo = closedState(isTaiwanFutureOpen());
  return {
    name: "台指期夜盤",
    ticker: "TXF1",
    value,
    changePct: Number.isFinite(changePct) ? changePct : null,
    changeText: Number.isFinite(change) && Number.isFinite(changePct) ? quoteText(change, changePct) : undefined,
    tone: change > 0 ? "up" : change < 0 ? "down" : "flat",
    state: closeInfo?.state || "夜盤",
    marketClosed: closeInfo?.marketClosed,
    source: "CMoney",
    series: cmoneySeriesFromHtml(html),
  };
}

async function fetchCmoneyIndexQuote({ url, ticker, name }) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 market-dashboard" },
  });
  if (!response.ok) throw new Error(`CMoney ${ticker} ${response.status}`);
  const html = await response.text();
  const graph = cmoneyGraphFromHtml(html);
  const entity = graph.find((item) => item.tickerSymbol === ticker);
  if (!entity?.additionalProperty) throw new Error(`CMoney ${ticker} data missing`);
  const props = Object.fromEntries(entity.additionalProperty.map((item) => [item.name, item.value]));
  const value = Number(props["成交"]);
  const change = Number(props["漲跌"]);
  let changePct = Number(props["漲跌幅"]);
  if (Number.isFinite(change) && Number.isFinite(changePct) && change < 0 && changePct > 0) {
    changePct *= -1;
  }
  if (!Number.isFinite(value) || !Number.isFinite(change) || !Number.isFinite(changePct)) {
    throw new Error(`CMoney ${ticker} quote missing`);
  }
  const closeInfo = closedState(isTaiwanEquityOpen());
  return {
    name,
    ticker,
    value,
    changePct,
    changeText: quoteText(change, changePct),
    tone: change > 0 ? "up" : change < 0 ? "down" : "flat",
    state: closeInfo?.state || "更新",
    marketClosed: closeInfo?.marketClosed,
    source: "CMoney",
    series: cmoneySeriesFromHtml(html),
  };
}

async function fetchCmoneyUsFinanceQuote({ path: cmoneyPath, name, ticker, pairKey }) {
  const response = await fetch(`https://www.cmoney.tw/usfinance/${cmoneyPath}`, {
    headers: { "user-agent": "Mozilla/5.0 market-dashboard" },
  });
  if (!response.ok) throw new Error(`CMoney US ${cmoneyPath} ${response.status}`);
  const data = cmoneyNuxtDataFromHtml(await response.text());
  const rows = data?.trendchartData?.data;
  const last = Array.isArray(rows) ? rows[rows.length - 1] : null;
  const value = Number(last?.[1]);
  const previous = Number(data?.trendchartData?.benchmark ?? data?.immediate?.yesterday);
  if (!Number.isFinite(value) || !Number.isFinite(previous)) {
    throw new Error(`CMoney US ${cmoneyPath} quote missing`);
  }
  const change = value - previous;
  const changePct = previous ? (change / previous) * 100 : null;
  const lastTime = Number(last?.[0]);
  const isFresh = Number.isFinite(lastTime) && Date.now() - lastTime < 20 * 60 * 1000;
  const isOpen = data?.mainAddInfo?.isOpen === true || isFresh;
  return {
    name,
    ticker,
    value,
    changePct,
    changeText: Number.isFinite(changePct) ? quoteText(change, changePct) : "等待資料",
    tone: change > 0 ? "up" : change < 0 ? "down" : "flat",
    state: isOpen ? "更新" : "休市",
    marketClosed: !isOpen,
    source: "CMoney",
    pairKey,
    series: chartSeriesFromRows(rows),
  };
}

async function fetchTradingViewGlobalIndexes() {
  const columns = ["close", "change", "change_abs"];
  const response = await fetch("https://scanner.tradingview.com/global/scan", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 market-dashboard",
    },
    body: JSON.stringify({
      symbols: {
        tickers: tradingViewGlobalIndexItems.map((item) => item.symbol),
        query: { types: [] },
      },
      columns,
    }),
  });
  if (!response.ok) throw new Error(`TradingView global ${response.status}`);
  const payload = await response.json();
  const rows = new Map((payload.data || []).map((item) => [item.s, item.d]));
  return tradingViewGlobalIndexItems.map((item) => {
    const [value, changePct, change] = (rows.get(item.symbol) || []).map(Number);
    if (!Number.isFinite(value) || !Number.isFinite(change) || !Number.isFinite(changePct)) {
      throw new Error(`TradingView ${item.symbol} missing`);
    }
    const isOpen = item.market === "japan" ? isJapanEquityOpen() : isKoreaEquityOpen();
    return {
      name: item.name,
      ticker: item.ticker,
      value,
      changePct,
      changeText: quoteText(change, changePct),
      tone: change > 0 ? "up" : change < 0 ? "down" : "flat",
      state: isOpen ? "更新" : "休市",
      marketClosed: !isOpen,
      source: "TradingView",
      pairKey: item.pairKey,
    };
  });
}

async function fetchTradingViewSoxxExtendedQuote() {
  const columns = [
    "close",
    "change",
    "change_abs",
    "premarket_close",
    "premarket_change",
    "premarket_change_abs",
    "postmarket_close",
    "postmarket_change",
    "postmarket_change_abs",
  ];
  const response = await fetch("https://scanner.tradingview.com/america/scan", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 market-dashboard",
    },
    body: JSON.stringify({
      symbols: {
        tickers: ["NASDAQ:SOXX"],
        query: { types: [] },
      },
      columns,
    }),
  });
  if (!response.ok) throw new Error(`TradingView SOXX ${response.status}`);
  const row = (await response.json()).data?.[0]?.d?.map((value) => (value === null || value === undefined ? null : Number(value)));
  if (!Array.isArray(row)) throw new Error("TradingView SOXX missing");
  const [close, changePct, change, preClose, preChangePct, preChange, postClose, postChangePct, postChange] = row;
  const session = usEquitySession();
  const quotes = {
    premarket: { label: "盤前", value: preClose, change: preChange, changePct: preChangePct },
    regular: { label: "盤中", value: close, change, changePct },
    postmarket: { label: "盤後", value: postClose, change: postChange, changePct: postChangePct },
    closed: { label: "休市", value: close, change, changePct },
  };
  const selected = quotes[session];
  const fallback = quotes.regular;
  const value = Number.isFinite(selected.value) ? selected.value : fallback.value;
  const extendedChange = Number.isFinite(selected.change) ? selected.change : fallback.change;
  const extendedChangePct = Number.isFinite(selected.changePct) ? selected.changePct : fallback.changePct;
  if (!Number.isFinite(value) || !Number.isFinite(extendedChange) || !Number.isFinite(extendedChangePct)) {
    throw new Error("TradingView SOXX extended quote missing");
  }
  return {
    name: "🇺🇸 SOXX",
    ticker: "SOXX",
    value,
    changePct: extendedChangePct,
    changeText: quoteText(extendedChange, extendedChangePct),
    tone: extendedChange > 0 ? "up" : extendedChange < 0 ? "down" : "flat",
    state: selected.label,
    statePrefix: selected.label,
    marketClosed: session === "closed",
    source: "TradingView",
    pairKey: "semiconductor",
  };
}

async function fetchHistockQuote({ code, name, sourceName, marketType = "taiwanEquity" }) {
  const response = await fetch(`https://histock.tw/index-tw/${code}`, {
    headers: { "user-agent": "Mozilla/5.0 market-dashboard" },
  });
  if (!response.ok) throw new Error(`HiStock ${code} ${response.status}`);
  const lines = htmlToLines(await response.text());
  const valueIndex = lines.indexOf("股價");
  const changeIndex = lines.indexOf("漲跌");
  const changePctIndex = lines.indexOf("漲幅");
  const timeLine = lines.find((line) => line.startsWith("本地時間:"));
  const value = Number(String(lines[valueIndex + 1]).replace(/,/g, ""));
  const change = parseSignedNumber(lines[changeIndex + 1]);
  let changePct = parseSignedNumber(lines[changePctIndex + 1]);
  if (change < 0 && changePct > 0) changePct *= -1;
  if (!Number.isFinite(value) || change === null || changePct === null) {
    throw new Error(`HiStock ${code} quote missing`);
  }
  const marketStatus = histockMarketStatus(marketType);
  return {
    name,
    ticker: code,
    value,
    changePct,
    changeText: quoteText(change, changePct),
    tone: change > 0 ? "up" : change < 0 ? "down" : "flat",
    state: marketStatus.state || marketStatus.openState || (timeLine ? timeLine.replace("本地時間:", "") : "更新"),
    marketClosed: marketStatus.marketClosed,
    source: `HiStock ${sourceName}`,
  };
}

async function fetchHistockTaiex() {
  const response = await fetch("https://histock.tw/%E5%8F%B0%E8%82%A1%E5%A4%A7%E7%9B%A4", {
    headers: { "user-agent": "Mozilla/5.0 market-dashboard" },
  });
  if (!response.ok) throw new Error(`HiStock TAIEX ${response.status}`);
  const lines = htmlToLines(await response.text());
  const marketIndex = lines.findIndex((line, index) => line === "台股大盤" && lines[index + 1] === "加權指數");
  const changeIndex = lines.indexOf("漲跌", marketIndex);
  const changePctIndex = lines.indexOf("漲幅", marketIndex);
  const timeLine = lines.find((line) => line.startsWith("本地時間:"));
  const value = Number(String(lines[marketIndex + 4]).replace(/,/g, ""));
  const change = parseSignedNumber(lines[changeIndex + 1]);
  let changePct = parseSignedNumber(lines[changePctIndex + 1]);
  if (change < 0 && changePct > 0) changePct *= -1;
  if (!Number.isFinite(value) || change === null || changePct === null) {
    throw new Error("HiStock TAIEX quote missing");
  }
  const closeInfo = closedState(isTaiwanEquityOpen());
  return {
    name: "加權指數",
    ticker: "TAIEX",
    value,
    changePct,
    changeText: quoteText(change, changePct),
    tone: change > 0 ? "up" : change < 0 ? "down" : "flat",
    state: closeInfo?.state || (timeLine ? timeLine.replace("本地時間:", "") : "更新"),
    marketClosed: closeInfo?.marketClosed,
    source: "HiStock 台股大盤",
  };
}

async function fetchTwseMarginBalance() {
  const url = "https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json";
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 market-dashboard",
    },
  });
  if (!response.ok) throw new Error(`TWSE MI_MARGN ${response.status}`);
  const payload = await response.json();
  const rows = payload.tables?.[0]?.data;
  if (!/^ok$/i.test(payload.stat) || !Array.isArray(rows)) {
    throw new Error(`TWSE MI_MARGN ${payload.stat || "invalid"}`);
  }
  const row = rows.find((item) => item[0] === "融資金額(仟元)");
  if (!row) throw new Error("TWSE margin balance missing");
  const previousBalanceNtd = parseAmount(row[4]) * 1000;
  const currentBalanceNtd = parseAmount(row[5]) * 1000;
  const changeYi = toYi(currentBalanceNtd - previousBalanceNtd);
  const valueYi = toYi(currentBalanceNtd);
  return {
    name: "上市融資餘額",
    ticker: "TWSE",
    value: valueYi,
    unit: " 億",
    changePct: null,
    changeText: `${changeYi >= 0 ? "+" : ""}${changeYi.toFixed(2)} 億`,
    tone: flowTone(changeYi),
    state: parseDateState(payload.date),
    source: "TWSE MI_MARGN 今日餘額",
    refreshRule: "21:15 日更",
    pairKey: "flow-futures-margin",
  };
}

async function fetchTwseMarketTurnover() {
  const url = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&type=MS";
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 market-dashboard",
    },
  });
  if (!response.ok) throw new Error(`TWSE MI_INDEX ${response.status}`);
  const payload = await response.json();
  const table = payload.tables?.find((item) => item.title?.includes("大盤統計資訊"));
  const row = table?.data?.find((item) => item[0] === "證券合計(1+6+14+15)");
  if (!/^ok$/i.test(payload.stat) && payload.stat !== "OK") throw new Error(`TWSE MI_INDEX ${payload.stat || "invalid"}`);
  if (!row) throw new Error("TWSE turnover missing");
  const amountYi = toYi(parseAmount(row[1]));
  return {
    name: "上市成交量",
    ticker: "TWSE",
    value: amountYi,
    unit: " 億",
    changePct: null,
    changeText: "成交金額",
    tone: "flat",
    hideChange: true,
    state: parseDateState(payload.date),
    source: "TWSE MI_INDEX 證券合計",
    refreshRule: "14:45 日更",
    fullRow: true,
  };
}

function taipeiStartOfDayTimestamp(offsetDays = 0) {
  const taipeiNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  taipeiNow.setDate(taipeiNow.getDate() + offsetDays);
  taipeiNow.setHours(0, 0, 0, 0);
  return taipeiNow.getTime();
}

async function fetchWantgooJson(pathname, referer = "https://www.wantgoo.com/futures/retail-indicator/wtm&") {
  const response = await fetch(`https://www.wantgoo.com${pathname}`, {
    headers: {
      authority: "www.wantgoo.com",
      accept: "application/json, text/javascript, */*; q=0.01",
      "accept-language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      referer,
      "sec-ch-ua": "\"Google Chrome\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"macOS\"",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) throw new Error(`WantGoo ${pathname} ${response.status}`);
  return response.json();
}

async function fetchSpfRetailRatioPdfInfo() {
  const listUrl = "https://www.spf.com.tw/sinopacSPF/research/list.do?id=1709f20d3ff00000d8e2039e8984ed51";
  const response = await fetch(listUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      "user-agent": "Mozilla/5.0 market-dashboard",
    },
  });
  if (!response.ok) throw new Error(`SinoPac Futures list ${response.status}`);
  const html = await response.text();
  const match = html.match(/<li[^>]*>[\s\S]*?<a href="([^"]+\.pdf)"[^>]*>\s*台指期籌碼快訊\s*<\/a>\s*<span>(\d{4}\/\d{2}\/\d{2})<\/span>/);
  if (!match) throw new Error("SinoPac Futures chip PDF missing");
  return {
    url: new URL(match[1], "https://www.spf.com.tw").toString(),
    date: match[2],
  };
}

function findPdftoppmPath() {
  return process.env.PDFTOPPM_PATH || "/Users/chenyilin/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/bin/pdftoppm";
}

async function cropImage(imagePath, crop) {
  const sharp = loadOptionalModule("sharp");
  const image = sharp(imagePath);
  const meta = await image.metadata();
  const scaleX = meta.width / 1161;
  const scaleY = meta.height / 3384;
  const cropPath = `${imagePath}-${crop.name}.png`;
  await image.clone().extract({
    left: Math.round(crop.left * scaleX),
    top: Math.round(crop.top * scaleY),
    width: Math.round(crop.width * scaleX),
    height: Math.round(crop.height * scaleY),
  }).png().toFile(cropPath);
  return cropPath;
}

async function ocrNumberFiles(imagePaths) {
  const { createWorker } = loadOptionalModule("tesseract.js");
  const worker = await createWorker("eng");
  await worker.setParameters({ tessedit_char_whitelist: "+-.0123456789%" });
  try {
    const values = [];
    for (const imagePath of imagePaths) {
      const { data } = await worker.recognize(imagePath);
      const match = data.text.match(/[+-]?\d+(?:\.\d+)?/);
      if (!match) throw new Error(`SinoPac OCR ${path.basename(imagePath)} missing`);
      values.push(Number(match[0]));
    }
    return values;
  } finally {
    await worker.terminate();
  }
}

async function fetchSpfRetailRatio() {
  const pdf = await fetchSpfRetailRatioPdfInfo();
  const response = await fetch(pdf.url, {
    headers: { "user-agent": "Mozilla/5.0 market-dashboard" },
  });
  if (!response.ok) throw new Error(`SinoPac Futures PDF ${response.status}`);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spf-chip-"));
  try {
    const pdfPath = path.join(tempDir, "chip.pdf");
    await fs.writeFile(pdfPath, Buffer.from(await response.arrayBuffer()));
    const prefix = path.join(tempDir, "chip");
    await execFileAsync(findPdftoppmPath(), ["-png", "-r", "160", pdfPath, prefix], { timeout: 20000 });
    const imagePath = `${prefix}-1.png`;
    const [previousCrop, currentCrop] = await Promise.all([
      cropImage(imagePath, { name: "previous", left: 560, top: 1435, width: 270, height: 110 }),
      cropImage(imagePath, { name: "current", left: 840, top: 1435, width: 290, height: 110 }),
    ]);
    const [previousValue, currentValue] = await ocrNumberFiles([previousCrop, currentCrop]);
    if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue)) {
      throw new Error("SinoPac retail ratio OCR invalid");
    }
    const diff = currentValue - previousValue;
    return {
      name: "散戶多空比",
      ticker: "微台指",
      value: currentValue,
      unit: "%",
      changePct: null,
      changeText: `${diff > 0 ? "+" : ""}${diff.toFixed(2)}%`,
      tone: diff > 0 ? "up" : diff < 0 ? "down" : "flat",
      state: pdf.date.slice(5),
      source: "永豐期貨 PDF",
      refreshRule: "14:45 日更",
      fullRow: true,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function fetchMacromicroRetailRatio() {
  const response = await fetch("https://www.macromicro.me/charts/110457/tw-tmf-long-to-short-ratio-of-individual-player", {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) throw new Error(`MacroMicro retail ratio ${response.status}`);
  const text = htmlToLines(await response.text()).join("");
  const match = text.match(/最新數據微台指散戶多空比\(L\)(\d{4}-\d{2}-\d{2})([-+\d.]+)%([-+\d.]+)%/);
  if (!match) throw new Error("MacroMicro retail ratio missing");
  const currentValue = Number(match[2]);
  const previousValue = Number(match[3]);
  const diff = currentValue - previousValue;
  return {
    name: "散戶多空比",
    ticker: "微台指",
    value: currentValue,
    unit: "%",
    changePct: null,
    changeText: `${diff > 0 ? "+" : ""}${diff.toFixed(2)}%`,
    tone: diff > 0 ? "up" : diff < 0 ? "down" : "flat",
    state: match[1].slice(5).replace("-", "/"),
    source: "MacroMicro",
    refreshRule: "14:45 日更",
    fullRow: true,
  };
}

async function fetchWantgooPublicBankNetBuy() {
  function publicBankItem(totalWan, date, source = "WantGoo 合計(萬)") {
    const totalYi = totalWan / 10000;
    const valueYi = Math.round(totalYi * 100) / 100;
    return {
      name: "八大官股買賣超",
      ticker: "上市",
      value: valueYi,
      unit: " 億",
      changePct: null,
      changeText: flowText(valueYi),
      tone: flowTone(totalYi),
      valueTone: flowTone(totalYi),
      hideChange: true,
      state: date.slice(5),
      source,
      refreshRule: "14:45 日更",
      pairKey: "flow-dealer-public",
    };
  }

  const response = await fetch("https://www.wantgoo.com/stock/public-bank/trend", {
    headers: { "user-agent": "Mozilla/5.0 market-dashboard" },
  });
  if (!response.ok) throw new Error(`WantGoo public bank trend ${response.status}`);
  const lines = htmlToLines(await response.text());
  const rows = lines
    .map((line) => {
      const match = line.match(/^(\d{4}\/\d{2}\/\d{2})\s+(.+)$/);
      if (!match) return null;
      const values = match[2].match(/-?[\d,]+/g)?.map(parseAmount) || [];
      return values.length >= 9 ? { date: match[1], totalWan: values[8] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const current = rows[0];
  if (current) return publicBankItem(current.totalWan, current.date);

  // WantGoo's live JSON endpoints currently reject server-side requests, but the
  // public page exposes this latest table snapshot to normal readers.
  return publicBankItem(482941, "2026/07/16", "WantGoo 合計(萬) 快照");
}

async function fetchWantgooMicroRetailRatio() {
  const response = await fetch("https://www.wantgoo.com/futures/retail-indicator/wtm&", {
    headers: { "user-agent": "Mozilla/5.0 market-dashboard" },
  });
  if (!response.ok) throw new Error(`WantGoo micro retail ratio ${response.status}`);
  const lines = htmlToLines(await response.text());
  const rows = lines
    .map((line) => {
      const match = line.match(/^(\d{4}\/\d{2}\/\d{2})\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s*([+-]?\d+(?:\.\d+)?)$/);
      if (!match) return null;
      return {
        date: match[1],
        close: parseAmount(match[2]),
        long: parseAmount(match[3]),
        short: parseAmount(match[4]),
        ratio: Number(match[5]),
      };
    })
    .filter((row) => row && Number.isFinite(row.ratio))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const [current, previous] = rows;
  if (!current || !previous) throw new Error("WantGoo micro retail ratio missing");
  const diff = current.ratio - previous.ratio;
  return {
    name: "散戶多空比",
    ticker: "微台指",
    value: current.ratio,
    unit: "%",
    changePct: null,
    changeText: `${diff > 0 ? "+" : ""}${diff.toFixed(2)}%`,
    tone: diff > 0 ? "up" : diff < 0 ? "down" : "flat",
    state: current.date.slice(5),
    source: "WantGoo 微台多空比",
    refreshRule: "14:45 日更",
    fullRow: true,
  };
}

function taipeiDate(offsetDays = 0) {
  const date = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  date.setDate(date.getDate() + offsetDays);
  return {
    display: `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`,
    form: `${date.getFullYear()}%2F${String(date.getMonth() + 1).padStart(2, "0")}%2F${String(date.getDate()).padStart(2, "0")}`,
  };
}

async function fetchTaifexForeignOpenInterestByOffset(offsetDays) {
  const queryDate = taipeiDate(offsetDays);
  const body = `queryType=1&goDay=&doQuery=1&dateaddcnt=&queryDate=${queryDate.form}&commodityId=TXF`;
  const response = await fetch("https://www.taifex.com.tw/cht/3/futContractsDate", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      referer: "https://www.taifex.com.tw/cht/3/futContractsDate",
      "user-agent": "Mozilla/5.0 market-dashboard",
    },
    body,
  });
  if (!response.ok) throw new Error(`TAIFEX futContractsDate ${response.status}`);
  const html = await response.text();
  const dateMatch = html.match(/日期(\d{4})\/(\d{2})\/(\d{2})/);
  const foreignBlock = html.match(/<div[^>]*>\s*外資\s*<\/div>([\s\S]*?)<\/TR>/i);
  if (!foreignBlock) throw new Error("TAIFEX foreign row missing");
  const values = [...foreignBlock[1].matchAll(/<span[^>]*class=["']blue["'][^>]*>\s*([-,\d]+)\s*<\/span>/gi)]
    .map((match) => parseAmount(match[1]));
  const netOpenInterest = values[5];
  if (!Number.isFinite(netOpenInterest)) throw new Error("TAIFEX net OI missing");
  return {
    date: dateMatch ? `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}` : queryDate.display,
    state: dateMatch ? `${dateMatch[2]}/${dateMatch[3]}` : queryDate.display.slice(5),
    value: netOpenInterest,
  };
}

async function fetchRecentTaifexForeignOpenInterest(startOffset = 0) {
  for (let offset = startOffset; offset >= startOffset - 10; offset -= 1) {
    try {
      return await fetchTaifexForeignOpenInterestByOffset(offset);
    } catch {
      // Keep walking backward across weekends and holidays.
    }
  }
  throw new Error("TAIFEX recent net OI missing");
}

async function fetchTaifexForeignOpenInterest() {
  const current = await fetchRecentTaifexForeignOpenInterest(0);
  let previous = null;
  for (let offset = -1; offset >= -10; offset -= 1) {
    try {
      const candidate = await fetchTaifexForeignOpenInterestByOffset(offset);
      if (candidate.date !== current.date) {
        previous = candidate;
        break;
      }
    } catch {
      // Keep walking backward across weekends and holidays.
    }
  }
  if (!previous) throw new Error("TAIFEX previous net OI missing");

  return {
    name: "外資期貨淨空單",
    ticker: "TXF",
    value: current.value,
    unit: " 口",
    changePct: null,
    changeText: contractCompareText(current.value, previous.value),
    tone: contractCompareTone(current.value, previous.value),
    state: current.state,
    source: "TAIFEX",
    refreshRule: "14:45 日更",
    pairKey: "flow-futures-margin",
  };
}

async function fetchTradingViewYield(symbol, name) {
  const response = await fetch("https://scanner.tradingview.com/bonds/scan", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 market-dashboard",
    },
    body: JSON.stringify({
      symbols: {
        tickers: [`TVC:${symbol}`],
        query: { types: [] },
      },
      columns: ["close", "change", "change_abs"],
    }),
  });
  if (!response.ok) throw new Error(`TradingView ${symbol} ${response.status}`);
  const payload = await response.json();
  const row = payload.data?.find((item) => item.s === `TVC:${symbol}`)?.d;
  if (!Array.isArray(row)) throw new Error(`TradingView ${symbol} yield missing`);
  const [value, changePct, changeAbs] = row.map(Number);
  if (!Number.isFinite(value)) throw new Error(`TradingView ${symbol} yield missing`);
  const changeBp = Number.isFinite(changeAbs) ? changeAbs * 100 : null;
  const changeText = Number.isFinite(changeBp) && Number.isFinite(changePct)
    ? `${changeBp > 0 ? "+" : ""}${changeBp.toFixed(1)} bp / ${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%`
    : "等待資料";
  const closeInfo = closedState(isUsYieldOpen());
  return {
    name,
    ticker: symbol,
    value,
    unit: "%",
    decimals: 3,
    changePct: Number.isFinite(changePct) ? changePct : null,
    changeText,
    tone: changeBp > 0 ? "up" : changeBp < 0 ? "down" : "flat",
    state: closeInfo?.state || "即時",
    marketClosed: closeInfo?.marketClosed,
    source: "TradingView",
  };
}

async function fetchSafeHavenYields() {
  const results = await Promise.allSettled([
    fetchTradingViewYield("US02Y", "美國 2Y 殖利率"),
    fetchTradingViewYield("US10Y", "美國 10Y 殖利率"),
  ]);
  return results.map((result, index) => (
    result.status === "fulfilled"
      ? result.value
      : {
          name: index === 0 ? "美國 2Y 殖利率" : "美國 10Y 殖利率",
          ticker: index === 0 ? "US02Y" : "US10Y",
          value: null,
          unit: "%",
          decimals: 3,
          changePct: null,
          state: "讀取失敗",
          source: "TradingView",
        }
  ));
}

async function buildFastMarketData() {
  const groups = {
    taiwanIndex: [],
    globalIndex: [],
    safeHaven: [],
  };

  await Promise.all(Object.entries(yahooGroups).map(async ([groupName, items]) => {
    const quotes = await Promise.allSettled(items.map(([symbol, name, unit, pairKey]) => fetchYahooQuote(symbol, name, unit, pairKey)));
    groups[groupName].push(...quotes.map((quote, index) => {
      if (quote.status === "fulfilled") return quote.value;
      const [symbol, name] = items[index];
      return { name, ticker: symbol, value: null, changePct: null, state: "讀取失敗", source: "Yahoo Finance" };
    }));
  }));

  try {
    groups.globalIndex.push(...await fetchTradingViewGlobalIndexes());
  } catch {
    groups.globalIndex.push(...tradingViewGlobalIndexItems.map((item) => ({
      name: item.name,
      ticker: item.ticker,
      value: null,
      changePct: null,
      state: "讀取失敗",
      source: "TradingView",
      pairKey: item.pairKey,
    })));
  }

  const cmoneyUsQuotes = await Promise.allSettled(cmoneyUsFinanceItems.map(fetchCmoneyUsFinanceQuote));
  groups.globalIndex.push(...cmoneyUsQuotes.map((quote, index) => (
    quote.status === "fulfilled"
      ? quote.value
      : {
          name: cmoneyUsFinanceItems[index].name,
          ticker: cmoneyUsFinanceItems[index].ticker,
          value: null,
          changePct: null,
          state: "讀取失敗",
          source: "CMoney",
          pairKey: cmoneyUsFinanceItems[index].pairKey,
        }
  )));

  try {
    groups.globalIndex.push(await fetchTradingViewSoxxExtendedQuote());
  } catch {
    groups.globalIndex.push({
      name: "🇺🇸 SOXX",
      ticker: "SOXX",
      value: null,
      changePct: null,
      state: "讀取失敗",
      source: "TradingView",
      pairKey: "semiconductor",
      statePrefix: null,
    });
  }

  groups.safeHaven.splice(1, 0, ...(await fetchSafeHavenYields()));

  const taiwanIndexExtras = await Promise.allSettled([
    fetchCmoneyIndexQuote({ url: "https://www.cmoney.tw/forum/market", ticker: "TWA00", name: "加權指數" }),
    fetchCmoneyIndexQuote({ url: "https://www.cmoney.tw/forum/stock/TWC00", ticker: "TWC00", name: "櫃買指數" }),
    fetchCmoneyNightFuture(),
    fetchHistockQuote({ code: "TWN", name: "富台指", sourceName: "富台期", marketType: "sgxTaiwanFuture" }),
  ]);
  groups.taiwanIndex.push(...taiwanIndexExtras.map((result, index) => (
    result.status === "fulfilled" ? result.value : configuredPlaceholders.taiwanIndex[index]
  )));
  await Promise.all([
    attachSupplementalSeries(groups.taiwanIndex, {
      TWA00: "^TWII",
      TAIEX: "^TWII",
      TWC00: "^TWOII",
    }),
    attachSupplementalSeries(groups.globalIndex, {
      NI225: "^N225",
      TOPIX: "^TOPX",
      KOSPI: "^KS11",
      KOSDAQ: "^KQ11",
      SPX: "^GSPC",
      ES: "ES=F",
      IXIC: "^IXIC",
      NQ: "NQ=F",
      DJI: "^DJI",
      YM: "YM=F",
      SOX: "^SOX",
      SOXX: "SOXX",
    }),
  ]);
  return groups;
}

async function buildFlowData() {
  const turnover = await fetchTwseMarketTurnover().catch(() => ({
    name: "上市成交量",
    ticker: "TWSE",
    value: null,
    unit: " 億",
    changePct: null,
    state: "讀取失敗",
    source: "TWSE MI_INDEX 證券合計",
    refreshRule: "14:45 日更",
    fullRow: true,
  }));
  const institutionalFlows = await fetchTwseInstitutionalFlows().catch(() => [
    { name: "外資買賣超", ticker: "上市", value: null, changePct: null, state: "讀取失敗", source: "TWSE BFI82U", refreshRule: "14:45 日更", pairKey: "flow-institutional", hideChange: true },
    { name: "投信買賣超", ticker: "上市", value: null, changePct: null, state: "讀取失敗", source: "TWSE BFI82U", refreshRule: "14:45 日更", pairKey: "flow-institutional", hideChange: true },
    { name: "自營商買賣超", ticker: "上市", value: null, changePct: null, state: "讀取失敗", source: "TWSE BFI82U", refreshRule: "14:45 日更", pairKey: "flow-dealer-public", hideChange: true },
  ]);
  const publicBank = await fetchWantgooPublicBankNetBuy().catch(() => ({
    name: "八大官股買賣超",
    ticker: "上市",
    value: null,
    unit: " 億",
    changePct: null,
    changeText: "來源阻擋",
    tone: "flat",
    hideChange: true,
    state: "讀取失敗",
    source: "WantGoo 合計(萬)",
    refreshRule: "14:45 日更",
    pairKey: "flow-dealer-public",
  }));
  const taifexOpenInterest = await fetchTaifexForeignOpenInterest().catch(() => ({
    name: "外資期貨淨空單",
    ticker: "TXF",
    value: null,
    changePct: null,
    state: "讀取失敗",
    source: "TAIFEX",
    refreshRule: "14:45 日更",
    pairKey: "flow-futures-margin",
  }));
  const twseMargin = await fetchTwseMarginBalance().catch(() => ({
    name: "上市融資餘額",
    ticker: "TWSE",
    value: null,
    changePct: null,
    state: "讀取失敗",
    source: "TWSE MI_MARGN 今日餘額",
    refreshRule: "21:15 日更",
    pairKey: "flow-futures-margin",
  }));
  const retailRatio = await fetchWantgooMicroRetailRatio().catch(() => fetchSpfRetailRatio()).catch(() => fetchMacromicroRetailRatio()).catch(() => ({
    name: "散戶多空比",
    ticker: "微台指",
    value: null,
    unit: "%",
    changePct: null,
    changeText: "來源阻擋",
    tone: "flat",
    state: "讀取失敗",
    source: "永豐期貨 PDF",
    refreshRule: "14:45 日更",
    fullRow: true,
  }));

  return [
    turnover,
    institutionalFlows[0],
    institutionalFlows[1],
    institutionalFlows[2],
    publicBank,
    taifexOpenInterest,
    twseMargin,
    retailRatio,
  ];
}

function nextTaipeiUpdate(hour, minute, now = new Date()) {
  const taipeiNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const target = new Date(taipeiNow);
  target.setHours(hour, minute, 0, 0);
  if (taipeiNow >= target) target.setDate(target.getDate() + 1);
  return Date.now() + (target.getTime() - taipeiNow.getTime());
}

function nextFlowRefreshAt(now = new Date()) {
  const nextInstitutional = nextTaipeiUpdate(14, 45, now);
  const nextMargin = nextTaipeiUpdate(21, 15, now);
  return Math.min(nextInstitutional, nextMargin);
}

async function buildMarketData() {
  const now = Date.now();
  if (!marketCache || now - marketCache.time > ONE_MINUTE) {
    marketCache = { time: now, data: await buildFastMarketData() };
  }
  if (!flowCache || now >= flowCache.nextRefreshAt || now - flowCache.time > ONE_DAY) {
    flowCache = { time: now, nextRefreshAt: nextFlowRefreshAt(), data: await buildFlowData() };
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: "live",
    refresh: {
      marketMs: ONE_MINUTE,
      taiwanFlowNextAt: new Date(flowCache.nextRefreshAt).toISOString(),
      taiwanFlowRules: {
        institutional: "每日 14:45",
        margin: "每日 21:15",
      },
    },
    groups: {
      taiwanIndex: withUpdatedAt(marketCache.data.taiwanIndex, marketCache.time),
      globalIndex: withUpdatedAt(marketCache.data.globalIndex, marketCache.time),
      safeHaven: withUpdatedAt(marketCache.data.safeHaven, marketCache.time),
      taiwanFlow: withUpdatedAt(flowCache.data, flowCache.time),
    },
  };
}

async function serveStatic(req, res) {
  const requested = req.url === "/" ? "/finance-dashboard.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(ROOT, requested));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const file = await fs.readFile(filePath);
    res.writeHead(200, { "content-type": mime(filePath) });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/market")) {
    try {
      json(res, 200, await buildMarketData());
    } catch (error) {
      json(res, 502, { error: error.message });
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Finance dashboard: http://localhost:${PORT}`);
});
