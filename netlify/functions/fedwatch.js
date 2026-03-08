// Netlify Function: Fetch FedWatch probabilities from CME (server-side, no CORS)
// Falls back to Fed Funds Futures calculation if CME is blocked

// ── CME Endpoints ──
const CME_URLS = [
  'https://www.cmegroup.com/services/fedWatchTool/v2/CMEFedWatchTool.json',
  'https://www.cmegroup.com/CmeWS/mvc/FedWatch/FedWatchData',
];

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html',
  'Origin': 'https://www.cmegroup.com',
};

// ── Target: Dec 9 2026 FOMC meeting ──
const TARGET_YEAR = 2026;
const TARGET_MONTH = 12;

// ── Futures fallback config ──
const FOMC_2026 = [
  { month: 3,  effDay: 19, dim: 31, ticker: 'ZQH26.CBT', gapBefore: null,         gapAfter: 'ZQJ26.CBT' },
  { month: 5,  effDay:  7, dim: 31, ticker: 'ZQK26.CBT', gapBefore: 'ZQJ26.CBT',  gapAfter: null },
  { month: 6,  effDay: 18, dim: 30, ticker: 'ZQM26.CBT', gapBefore: null,          gapAfter: null },
  { month: 7,  effDay: 30, dim: 31, ticker: 'ZQN26.CBT', gapBefore: null,          gapAfter: 'ZQQ26.CBT' },
  { month: 9,  effDay: 17, dim: 30, ticker: 'ZQU26.CBT', gapBefore: 'ZQQ26.CBT',  gapAfter: null },
  { month: 10, effDay: 29, dim: 31, ticker: 'ZQV26.CBT', gapBefore: null,          gapAfter: 'ZQX26.CBT' },
  { month: 12, effDay: 10, dim: 31, ticker: 'ZQZ26.CBT', gapBefore: 'ZQX26.CBT',  gapAfter: 'ZQF27.CBT' },
];
const LATE_THRESHOLD = 0.15;

// ═══════════════════════════════════════
//  1. Try CME directly (server-side)
// ═══════════════════════════════════════
async function fetchFromCME() {
  for (const url of CME_URLS) {
    try {
      const resp = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.includes('blocked') || text.includes('scraping')) {
        console.log(`CME blocked at ${url}`);
        continue;
      }
      const data = JSON.parse(text);
      const result = parseCmeResponse(data);
      if (result) return { ...result, source: 'CME FedWatch API (即時)' };
    } catch (e) {
      console.log(`CME fetch error (${url}): ${e.message}`);
    }
  }
  return null;
}

function parseCmeResponse(data) {
  try {
    // CME response is typically an array of meeting objects
    let meetings = null;
    if (Array.isArray(data)) meetings = data;
    else if (data.meetings) meetings = data.meetings;
    else if (data.data && Array.isArray(data.data)) meetings = data.data;
    else if (data.body && Array.isArray(data.body)) meetings = data.body;
    if (!meetings || !meetings.length) return null;

    // Find the December 2026 meeting
    let target = null;
    for (const m of meetings) {
      const s = JSON.stringify(m).toLowerCase();
      if (s.includes('2026') && (s.includes('dec') || s.includes('12/'))) {
        target = m;
        break;
      }
    }
    if (!target) target = meetings[meetings.length - 1];

    // Extract probability distribution
    const probFields = ['probabilities', 'cutProbabilities', 'distribution',
      'probs', 'targetRateProbs', 'bpsProbabilities'];
    let probData = null;
    for (const f of probFields) {
      if (target[f]) { probData = target[f]; break; }
    }
    if (!probData && target.data) {
      for (const f of probFields) {
        if (target.data[f]) { probData = target.data[f]; break; }
      }
    }
    if (!probData) return null;

    // Parse into {cutBps: probability%} format
    const result = {};

    if (Array.isArray(probData)) {
      // Typically sorted from highest rate (no change) to lowest
      probData.forEach((p, i) => {
        const val = typeof p === 'object'
          ? parseFloat(p.probability || p.prob || p.value || p.pct || 0)
          : parseFloat(p);
        if (!isNaN(val) && val > 0) result[i * 25] = val;
      });
    } else if (typeof probData === 'object') {
      // Keyed by rate range like "350-375" or by bps
      const entries = Object.entries(probData);
      entries.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
      entries.forEach(([k, v], i) => {
        const val = parseFloat(v);
        if (!isNaN(val) && val > 0) result[i * 25] = val;
      });
    }

    const vals = Object.values(result);
    if (vals.length < 2) return null;
    const sum = vals.reduce((a, b) => a + b, 0);
    if (sum < 50 || sum > 150) return null;

    return { probabilities: result };
  } catch (e) {
    console.log('parseCmeResponse error:', e);
    return null;
  }
}

// ═══════════════════════════════════════
//  2. Fallback: calculate from futures
// ═══════════════════════════════════════
async function fetchPrice(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' } });
  if (!r.ok) throw new Error(`${r.status} for ${ticker}`);
  const d = await r.json();
  const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!p) throw new Error(`No price for ${ticker}`);
  return p;
}

async function fetchCurrentRate() {
  const r = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS&cosd=2025-01-01');
  const text = await r.text();
  const lines = text.trim().split('\n');
  const last = lines[lines.length - 1].split(',');
  return parseFloat(last[1]);
}

function poissonBinomialPMF(probs) {
  const n = probs.length;
  let dp = new Array(n + 1).fill(0);
  dp[0] = 1;
  for (let i = 0; i < n; i++) {
    const p = probs[i];
    const newDp = new Array(n + 1).fill(0);
    for (let j = n; j >= 0; j--) {
      if (dp[j] === 0) continue;
      newDp[j] += dp[j] * (1 - p);
      newDp[j + 1] += dp[j] * p;
    }
    dp = newDp;
  }
  return dp;
}

async function calculateFromFutures() {
  const tickers = new Set();
  for (const m of FOMC_2026) {
    tickers.add(m.ticker);
    if (m.gapBefore) tickers.add(m.gapBefore);
    if (m.gapAfter) tickers.add(m.gapAfter);
  }

  const priceMap = {};
  const fetches = [...tickers].map(async t => {
    try { priceMap[t] = await fetchPrice(t); } catch (e) { console.log(e.message); }
  });
  let currentRate = null;
  fetches.push(fetchCurrentRate().then(r => { currentRate = r; }).catch(() => {}));
  await Promise.all(fetches);

  if (!currentRate) {
    const fm = priceMap['ZQH26.CBT'];
    currentRate = fm ? +(100 - fm).toFixed(2) : 3.64;
  }

  const currentTargetHi = Math.ceil(currentRate * 4) / 4;
  const now = new Date();
  const curMonth = now.getFullYear() === 2026 ? now.getMonth() + 1 : (now.getFullYear() < 2026 ? 0 : 13);

  let preRate = currentRate;
  const meetingProbs = [];
  const meetingDetails = [];

  for (const m of FOMC_2026) {
    if (!priceMap[m.ticker]) continue;
    if (curMonth > m.month) continue;

    if (m.gapBefore && priceMap[m.gapBefore]) {
      preRate = 100 - priceMap[m.gapBefore];
    }

    const monthlyImplied = 100 - priceMap[m.ticker];
    const dBefore = m.effDay - 1;
    const dAfter = m.dim - dBefore;
    const ratio = dAfter / m.dim;

    let postRate, method;
    if (ratio < LATE_THRESHOLD && m.gapAfter && priceMap[m.gapAfter]) {
      postRate = 100 - priceMap[m.gapAfter];
      method = 'gapAfter';
    } else {
      postRate = (m.dim * monthlyImplied - dBefore * preRate) / dAfter;
      postRate = Math.max(0, Math.min(10, postRate));
      method = 'sameMonth';
    }

    const expectedCutBps = (preRate - postRate) * 100;
    const pCut = Math.max(0, Math.min(1, expectedCutBps / 25));

    meetingProbs.push(pCut);
    meetingDetails.push({ month: m.month, preRate: +preRate.toFixed(4), postRate: +postRate.toFixed(4), expectedCutBps: +expectedCutBps.toFixed(1), pCut: +pCut.toFixed(4), method });
    preRate = postRate;
  }

  const pmf = poissonBinomialPMF(meetingProbs);
  const probabilities = {};
  for (let k = 0; k <= Math.min(meetingProbs.length, 8); k++) {
    const prob = pmf[k] * 100;
    if (prob >= 0.05) probabilities[k * 25] = +prob.toFixed(2);
  }

  return {
    probabilities,
    currentRate: +currentRate.toFixed(2),
    currentTargetHi,
    meetingsUsed: meetingProbs.length,
    meetingDetails,
    futuresPrices: Object.fromEntries(
      Object.entries(priceMap).map(([k, v]) => [k, { price: v, impliedRate: +(100 - v).toFixed(4) }])
    ),
    source: 'Fed Funds Futures 近似計算（僅供參考，可能與 CME 有 1-3% 誤差）',
  };
}

// ═══════════════════════════════════════
//  Handler
// ═══════════════════════════════════════
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=1800',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    // 1. Try CME direct fetch (server-side)
    const cmeResult = await fetchFromCME();
    if (cmeResult) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ...cmeResult,
          timestamp: new Date().toISOString(),
          method: 'cme_direct',
        }),
      };
    }

    // 2. Fallback: calculate from futures
    console.log('CME unavailable, falling back to futures calculation');
    const futuresResult = await calculateFromFutures();
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ...futuresResult,
        timestamp: new Date().toISOString(),
        method: 'futures_calc',
      }),
    };
  } catch (err) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message, fallback: true }),
    };
  }
};
