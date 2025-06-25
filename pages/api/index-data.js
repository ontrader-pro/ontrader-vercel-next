// pages/api/index-data.js

// CoinGecko endpoint (top 100, no sparkline)
const COINGECKO =
  'https://api.coingecko.com/api/v3/coins/markets'
  + '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
// Binance Futures endpoints
const BINANCE_FUTURES_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_KLINES      = 'https://fapi.binance.com/fapi/v1/klines';

// Exclude stablecoins
const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','USDP','GUSD','USDN']);

// Calculate EMA
function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  return arr.reduce((prev, value, idx) => idx ? (value * k + prev * (1 - k)) : value, 0);
}

// Calculate RSI
function calcRSI(arr) {
  let gains = 0, losses = 0;
  for (let i = 1; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgG = gains / (arr.length - 1);
  const avgL = losses / (arr.length - 1) || 1e-6;
  const rs = avgG / avgL;
  return 100 - (100 / (1 + rs));
}

// Fetch with retry and optional proxy fallback
async function fetchWithRetry(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 500 + i * 500));
    }
  }
}

// Find Sunday candle max/min
function getLastSundayMaxMin(klines) {
  if (!Array.isArray(klines) || klines.length === 0) return { max: NaN, min: NaN };
  for (let i = klines.length - 1; i >= 0; i--) {
    const date = new Date(klines[i][0]);
    if (date.getUTCDay() === 0) {
      return { max: Number(klines[i][2]), min: Number(klines[i][3]) };
    }
  }
  const last = klines[klines.length - 1];
  return { max: Number(last[2]), min: Number(last[3]) };
}

// Compute hierarchical score
function computeScore({ price, maxD, minD, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m }) {
  let score = 1;
  if (!isNaN(minD) && price > minD) score += 3;
  if (!isNaN(maxD) && price > maxD) score += 2;
  if (!isNaN(minD) && price < minD) score -= 2;
  if (rsi15m > 50 && price > ema28_15m) score += 2;
  if (rsi15m < 50 && price < ema28_15m) score -= 2;
  if (rsi5m > 70 && price > ema28_5m) score += 1;
  if (rsi5m < 30 && price < ema28_5m) score -= 1;
  if (rsi4m < 15) score += 0.5;
  if (rsi4m > 85) score -= 0.5;
  return Math.max(1, Math.min(10, score));
}

// Convert score to phase label
function phaseText(score) {
  if (score <= 3.0) return '🔴 Oversold';
  if (score < 4.9)  return '🔴 Bearish Incline';
  if (score < 6.0)  return '🟠 Accumulation';
  if (score < 8.1)  return '🟡 Bullish Incline';
  return '🟢 Overbought';
}

// In-memory state across invocations (warm lambdas)
const prevScores = {};
const prevPhases = {};
let alertHistory = [];

export default async function handler(req, res) {
  try {
    // 1) Fetch CoinGecko top100
    const cgList = await fetchWithRetry(COINGECKO);
    // 2) Fetch Binance Futures info
    const info = await fetchWithRetry(BINANCE_FUTURES_INFO);
    const validFutures = new Set(
      info.symbols
        .filter(s => s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
        .map(s => s.baseAsset)
    );
    // 3) Filter and map assets
    const assets = cgList
      .filter(c => c.symbol)
      .map(c => ({ symbol: c.symbol.toUpperCase(), bin: c.symbol.toUpperCase() + 'USDT', price: c.current_price }))
      .filter(a => !STABLES.has(a.symbol) && validFutures.has(a.symbol));

    const result = [];
    for (const asset of assets) {
      let score = 0, phase = 'NoTrade';
      const prev = prevScores[asset.symbol] || 0;
      try {
        // daily
        const dayK = await fetchWithRetry(`${BINANCE_KLINES}?symbol=${asset.bin}&interval=1d&limit=10`);
        const { max, min } = getLastSundayMaxMin(dayK);
        // 15m
        const k15 = await fetchWithRetry(`${BINANCE_KLINES}?symbol=${asset.bin}&interval=15m&limit=28`);
        const closes15 = k15.map(x => +x[4]);
        const ema28_15m = calcEMA(closes15, 28);
        const rsi15m    = calcRSI(closes15);
        // 5m
        const k5  = await fetchWithRetry(`${BINANCE_KLINES}?symbol=${asset.bin}&interval=5m&limit=28`);
        const closes5 = k5.map(x => +x[4]);
        const ema28_5m = calcEMA(closes5, 28);
        const rsi5m    = calcRSI(closes5);
        // 4m
        const k4  = await fetchWithRetry(`${BINANCE_KLINES}?symbol=${asset.bin}&interval=4m&limit=15`);
        const closes4 = k4.map(x => +x[4]);
        const rsi4m   = calcRSI(closes4);

        score = computeScore({ price: asset.price, maxD: max, minD: min, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m });
        phase = phaseText(score);
        const oldPhase = prevPhases[asset.symbol];
        if (oldPhase && oldPhase !== phase) {
          alertHistory.unshift({ time: new Date().toLocaleTimeString(), symbol: asset.symbol, oldPhase, newPhase: phase, price: asset.price, score: score.toFixed(2) });
          if (alertHistory.length > 20) alertHistory.pop();
        }
        prevScores[asset.symbol] = score;
        prevPhases[asset.symbol] = phase;
      } catch {
        phase = 'NoTrade';
      }
      result.push({ symbol: asset.symbol, price: +asset.price.toFixed(6), prevScore: prev.toFixed(2), score: score.toFixed(2), phase });
      await new Promise(r => setTimeout(r, 150));
    }

    return res.status(200).json({ data: result, alerts: alertHistory });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
