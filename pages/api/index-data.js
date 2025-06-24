import fetch from 'node-fetch';

// CoinGecko endpoint (top 100, no sparkline)
const COINGECKO =
  'https://api.coingecko.com/api/v3/coins/markets'
  + '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
// Binance Futures endpoints
const BINANCE_FUTURES_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_KLINES      = 'https://fapi.binance.com/fapi/v1/klines';
// Proxy fallback
const ALLORIGINS = 'https://api.allorigins.win/raw?url=';

// Exclude stablecoins
const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','USDP','GUSD','USDN']);

// EMA calculation
data: function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  return arr.reduce((a, v, i) => (i ? v * k + a * (1 - k) : v), 0);
}

// RSI calculation
function calcRSI(arr) {
  let gains = 0, losses = 0;
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  const avgG = gains / (arr.length - 1);
  const avgL = losses / (arr.length - 1) || 1e-6;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

// Fetch with retry + proxy fallback
async function fetchWithFallback(url, tries = 2) {
  let lastError;
  for (let i = 0; i <= tries; i++) {
    try {
      const res = await fetch(i > 0 && lastError?.status === 451 ? ALLORIGINS + encodeURIComponent(url) : url);
      if (!res.ok) {
        lastError = new Error(`Status ${res.status}`);
        lastError.status = res.status;
        throw lastError;
      }
      return await res.json();
    } catch (e) {
      if (i === tries) throw e;
      await new Promise(r => setTimeout(r, 600 + 400 * i));
    }
  }
}

// Get last Sunday's daily candle max/min
function getLastSundayMaxMin(klines) {
  if (!Array.isArray(klines) || !klines.length) {
    return { max: NaN, min: NaN };
  }
  for (let i = klines.length - 1; i >= 0; i--) {
    const d = new Date(klines[i][0]);
    if (d.getUTCDay() === 0) {
      return { max: Number(klines[i][2]), min: Number(klines[i][3]) };
    }
  }
  const last = klines[klines.length - 1];
  return { max: Number(last[2]), min: Number(last[3]) };
}

// Hierarchical score computation
function computeScore({ price, maxD, minD, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m }) {
  let s = 1;
  if (!isNaN(minD) && price > minD) s += 3;
  if (!isNaN(maxD) && price > maxD) s += 2;
  if (!isNaN(minD) && price < minD) s -= 2;
  if (rsi15m > 50 && price > ema28_15m) s += 2;
  if (rsi15m < 50 && price < ema28_15m) s -= 2;
  if (rsi5m > 70 && price > ema28_5m) s += 1;
  if (rsi5m < 30 && price < ema28_5m) s -= 1;
  if (rsi4m < 15) s += 0.5;
  if (rsi4m > 85) s -= 0.5;
  return Math.max(1, Math.min(10, s));
}

// Textual phase
function phaseText(score) {
  if (score <= 3.0) return '🔴 Oversold';
  if (score < 4.9) return '🔴 Bearish Incline';
  if (score < 6.0) return '🟠 Accumulation';
  if (score < 8.1) return '🟡 Bullish Incline';
  return '🟢 Overbought';
}

// In-memory persistence per lambda invocation
const prevScores = {};
const prevPhases = {};
const alerts = [];

export default async function handler(req, res) {
  try {
    // 1) Fetch top100 from CoinGecko
    const cgRaw = await fetchWithFallback(COINGECKO);
    const cg = Array.isArray(cgRaw)
      ? cgRaw
      : (Array.isArray(cgRaw.data) ? cgRaw.data : []);

    // 2) Fetch Binance Futures info
    const infoRaw = await fetchWithFallback(BINANCE_FUTURES_INFO);
    const symbolsList = Array.isArray(infoRaw.symbols) ? infoRaw.symbols : [];
    const futureSet = new Set(
      symbolsList
        .filter(s => s.contractType === 'PERPETUAL' && typeof s.symbol === 'string' && s.symbol.endsWith('USDT'))
        .map(s => s.baseAsset)
    );

    // 3) Filter top100 non-stable usable futures
    const assets = cg
      .filter(c => c && c.symbol && typeof c.symbol === 'string')
      .map(c => ({ symbol: c.symbol.toUpperCase(), bin: c.symbol.toUpperCase() + 'USDT', price: c.current_price }))
      .filter(a => !STABLES.has(a.symbol) && futureSet.has(a.symbol));

    const result = [];
    for (const a of assets) {
      let score = 0;
      let phase = '';
      try {
        // daily klines
        const day = await fetchWithFallback(`${BINANCE_KLINES}?symbol=${a.bin}&interval=1d&limit=10`);
        const { max, min } = getLastSundayMaxMin(day);

        // 15m klines
        const k15 = await fetchWithFallback(`${BINANCE_KLINES}?symbol=${a.bin}&interval=15m&limit=28`);
        const closes15 = Array.isArray(k15) ? k15.map(x => +x[4]) : [];
        const ema28_15m = calcEMA(closes15, 28);
        const rsi15m = calcRSI(closes15);

        // 5m klines
        const k5 = await fetchWithFallback(`${BINANCE_KLINES}?symbol=${a.bin}&interval=5m&limit=28`);
        const closes5 = Array.isArray(k5) ? k5.map(x => +x[4]) : [];
        const ema28_5m = calcEMA(closes5, 28);
        const rsi5m = calcRSI(closes5);

        // 4m klines
        const k4 = await fetchWithFallback(`${BINANCE_KLINES}?symbol=${a.bin}&interval=4m&limit=15`);
        const closes4 = Array.isArray(k4) ? k4.map(x => +x[4]) : [];
        const rsi4m = calcRSI(closes4);

        // compute score + phase
        score = computeScore({ price: a.price, maxD: max, minD: min, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m });
        phase = phaseText(score);

        const oldPhase = prevPhases[a.symbol];
        if (oldPhase && oldPhase !== phase) {
          alerts.unshift({ time: new Date().toLocaleTimeString(), symbol: a.symbol, oldPhase, newPhase: phase, price: a.price, score: score.toFixed(2) });
          if (alerts.length > 20) alerts.pop();
        }

        const prev = prevScores[a.symbol] || score;
        result.push({ symbol: a.symbol, price: +a.price.toFixed(6), prevScore: prev.toFixed(2), score: score.toFixed(2), phase });

        prevScores[a.symbol] = score;
        prevPhases[a.symbol] = phase;
        await new Promise(r => setTimeout(r, 200));
      } catch {
        const prev = prevScores[a.symbol] || 0;
        result.push({ symbol: a.symbol, price: 0, prevScore: prev.toFixed(2), score: '0.00', phase: 'NoTrade' });
      }
    }

    return res.status(200).json({ data: result, alerts });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
