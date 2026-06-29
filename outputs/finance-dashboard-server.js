const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const ONE_MINUTE = 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;
let marketCache = null;
let flowCache = null;

const yahooGroups = {
  taiwanIndex: [
    ["^TWII", "加權指數"],
  ],
  globalIndex: [
    ["^N225", "日經 225"],
    ["^KS11", "KOSPI"],
    ["^GSPC", "S&P 500"],
    ["^IXIC", "Nasdaq"],
    ["^DJI", "Dow Jones"],
    ["^SOX", "費城半導體"],
  ],
  safeHaven: [
    ["DX-Y.NYB", "美元指數"],
    ["^TNX", "美國 10Y 殖利率", "%"],
    ["GC=F", "黃金"],
    ["BZ=F", "布蘭特原油"],
    ["^VIX", "VIX"],
  ],
};

const configuredPlaceholders = {
  taiwanIndex: [
    { name: "櫃買指數", ticker: "TWOI", value: null, changePct: null, state: "讀取失敗", source: "HiStock 櫃檯指數" },
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

async function fetchYahooQuote(symbol, name, unit = "") {
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
  return {
    name,
    ticker: symbol,
    value,
    unit,
    changePct,
    state: meta.marketState || "更新",
    source: "Yahoo Finance",
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

function quoteText(change, changePct) {
  const sign = change > 0 ? "+" : "";
  return `${sign}${change.toFixed(2)} / ${sign}${changePct.toFixed(2)}%`;
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
      state: date,
      source: "TWSE BFI82U",
      refreshRule: "15:15 日更",
    },
    {
      name: "投信買賣超",
      ticker: "上市",
      value: investmentTrustNetYi,
      unit: " 億",
      changePct: null,
      changeText: flowText(investmentTrustNetYi),
      tone: flowTone(investmentTrustNetYi),
      state: date,
      source: "TWSE BFI82U",
      refreshRule: "15:15 日更",
    },
    {
      name: "自營商買賣超",
      ticker: "上市",
      value: dealerNetYi,
      unit: " 億",
      changePct: null,
      changeText: flowText(dealerNetYi),
      tone: flowTone(dealerNetYi),
      state: date,
      source: "TWSE BFI82U",
      refreshRule: "15:15 日更",
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
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const graph = scripts.flatMap((match) => {
    try {
      const parsed = JSON.parse(match[1]);
      return Array.isArray(parsed) ? parsed.flatMap((item) => item["@graph"] || []) : parsed["@graph"] || [];
    } catch {
      return [];
    }
  });
  const entity = graph.find((item) => item.tickerSymbol === "TXF1");
  if (!entity?.additionalProperty) throw new Error("CMoney TXF1 data missing");
  const props = Object.fromEntries(entity.additionalProperty.map((item) => [item.name, item.value]));
  const value = Number(props["成交"]);
  const change = Number(props["漲跌"]);
  const changePct = Number(props["漲跌幅"]);
  if (!Number.isFinite(value)) throw new Error("CMoney TXF1 price missing");
  return {
    name: "台指期夜盤",
    ticker: "TXF1",
    value,
    changePct: Number.isFinite(changePct) ? changePct : null,
    changeText: Number.isFinite(change) && Number.isFinite(changePct) ? quoteText(change, changePct) : undefined,
    tone: change > 0 ? "up" : change < 0 ? "down" : "flat",
    state: "夜盤",
    source: "CMoney",
  };
}

async function fetchHistockQuote({ code, name, sourceName }) {
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
  const changePct = parseSignedNumber(lines[changePctIndex + 1]);
  if (!Number.isFinite(value) || change === null || changePct === null) {
    throw new Error(`HiStock ${code} quote missing`);
  }
  return {
    name,
    ticker: code,
    value,
    changePct,
    changeText: quoteText(change, changePct),
    tone: change > 0 ? "up" : change < 0 ? "down" : "flat",
    state: timeLine ? timeLine.replace("本地時間:", "") : "更新",
    source: `HiStock ${sourceName}`,
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
    changeText: `今日-前日 ${changeYi >= 0 ? "+" : ""}${changeYi.toFixed(2)} 億`,
    tone: flowTone(changeYi),
    state: parseDateState(payload.date),
    source: "TWSE MI_MARGN 今日餘額",
    refreshRule: "21:15 日更",
  };
}

async function fetchTaifexForeignOpenInterest() {
  const today = new Date().toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).replace(/\//g, "%2F");
  const body = `queryType=1&goDay=&doQuery=1&dateaddcnt=&queryDate=${today}&commodityId=TXF`;
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
    name: "外資期貨淨空單",
    ticker: "TXF",
    value: netOpenInterest,
    unit: " 口",
    changePct: null,
    changeText: contractText(netOpenInterest),
    tone: netOpenInterest < 0 ? "down" : netOpenInterest > 0 ? "up" : "flat",
    state: dateMatch ? `${dateMatch[2]}/${dateMatch[3]}` : "盤後",
    source: "TAIFEX",
    refreshRule: "15:15 日更",
  };
}

async function buildFastMarketData() {
  const groups = {
    taiwanIndex: [],
    globalIndex: [],
    safeHaven: [],
  };

  await Promise.all(Object.entries(yahooGroups).map(async ([groupName, items]) => {
    const quotes = await Promise.allSettled(items.map(([symbol, name, unit]) => fetchYahooQuote(symbol, name, unit)));
    groups[groupName].push(...quotes.map((quote, index) => {
      if (quote.status === "fulfilled") return quote.value;
      const [symbol, name] = items[index];
      return { name, ticker: symbol, value: null, changePct: null, state: "讀取失敗", source: "Yahoo Finance" };
    }));
  }));

  const taiwanIndexExtras = await Promise.allSettled([
    fetchHistockQuote({ code: "TWOI", name: "櫃買指數", sourceName: "櫃檯指數" }),
    fetchCmoneyNightFuture(),
    fetchHistockQuote({ code: "TWN", name: "富台指", sourceName: "富台期" }),
  ]);
  groups.taiwanIndex.push(...taiwanIndexExtras.map((result, index) => (
    result.status === "fulfilled" ? result.value : configuredPlaceholders.taiwanIndex[index]
  )));
  return groups;
}

async function buildFlowData() {
  const institutionalFlows = await fetchTwseInstitutionalFlows().catch(() => [
    { name: "外資買賣超", ticker: "上市", value: null, changePct: null, state: "讀取失敗", source: "TWSE BFI82U", refreshRule: "15:15 日更" },
    { name: "投信買賣超", ticker: "上市", value: null, changePct: null, state: "讀取失敗", source: "TWSE BFI82U", refreshRule: "15:15 日更" },
    { name: "自營商買賣超", ticker: "上市", value: null, changePct: null, state: "讀取失敗", source: "TWSE BFI82U", refreshRule: "15:15 日更" },
  ]);
  const taifexOpenInterest = await fetchTaifexForeignOpenInterest().catch(() => ({
    name: "外資期貨淨空單",
    ticker: "TXF",
    value: null,
    changePct: null,
    state: "讀取失敗",
    source: "TAIFEX",
    refreshRule: "15:15 日更",
  }));
  const twseMargin = await fetchTwseMarginBalance().catch(() => ({
    name: "上市融資餘額",
    ticker: "TWSE",
    value: null,
    changePct: null,
    state: "讀取失敗",
    source: "TWSE MI_MARGN 今日餘額",
    refreshRule: "21:15 日更",
  }));

  return [...institutionalFlows, taifexOpenInterest, twseMargin];
}

function nextTaipeiUpdate(hour, minute, now = new Date()) {
  const taipeiNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const target = new Date(taipeiNow);
  target.setHours(hour, minute, 0, 0);
  if (taipeiNow >= target) target.setDate(target.getDate() + 1);
  return Date.now() + (target.getTime() - taipeiNow.getTime());
}

function nextFlowRefreshAt(now = new Date()) {
  const nextInstitutional = nextTaipeiUpdate(15, 15, now);
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
        institutional: "每日 15:15",
        margin: "每日 21:15",
      },
    },
    groups: {
      ...marketCache.data,
      taiwanFlow: flowCache.data,
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
