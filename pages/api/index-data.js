// pages/api/index-data.js
import fetch from 'node-fetch';

// CoinGecko endpoint (top 100, no sparkline)
const COINGECKO =
  'https://api.coingecko.com/api/v3/coins/markets'
  + '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
// Binance Futures endpoints
const BINANCE_FUTURES_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_KLINES = 'https://fapi.binance.com/fapi/v1/klines';
// Optional CORS/proxy fallback
const ALLORIGINS = 'https://api.allorigins.win/raw?url=';

// Exclude stablecoins
const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','USDP','GUSD','USDN']);

// EMA calculation
function calcEMA(arr, p) {
  const k = 2/(p+1);
  return arr.reduce((a,v,i)=> i? v*k + a*(1-k) : v, 0);
}
// RSI calculation
function calcRSI(arr) {
  let gains=0, losses=0;
  for (let i=1; i<arr.length; i++) {
    const d = arr[i] - arr[i-1];
    if (d>0) gains += d; else losses -= d;
  }
  const avgG = gains/(arr.length-1);
  const avgL = losses/(arr.length-1) || 1e-6;
  const rs = avgG/avgL;
  return 100 - (100/(1+rs));
}

// Fetch with retry + proxy fallback
async function fetchWithFallback(url, tries=2) {
  for (let i=0; i<=tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 451 && i===0) {
          url = ALLORIGINS + encodeURIComponent(url);
          continue;
        }
        throw new Error(`Status ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      if (i === tries) throw e;
      await new Promise(r => setTimeout(r, 600 + 400*i));
    }
  }
}

// Get last Sunday candle's max/min
function getLastSundayMaxMin(klines) {
  for (let i=klines.length-1; i>=0; i--) {
    if (new Date(klines[i][0]).getUTCDay() === 0) {
      return { max: +klines[i][2], min: +klines[i][3] };
    }
  }
  // Fallback to last candle
  const k = klines[klines.length-1];
  return { max: +k[2], min: +k[3] };
}

// Hierarchical score computation
function computeScore(params) {
  let s = 1;
  const { price, maxD, minD, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m } = params;
  if (price > minD) s += 3;
  if (price > maxD) s += 2;
  if (price < minD) s -= 2;
  if (rsi15m > 50 && price > ema28_15m) s += 2;
  if (rsi15m < 50 && price < ema28_15m) s -= 2;
  if (rsi5m > 70 && price > ema28_5m) s += 1;
  if (rsi5m < 30 && price < ema28_5m) s -= 1;
  if (rsi4m < 15) s += 0.5;
  if (rsi4m > 85) s -= 0.5;
  return Math.max(1, Math.min(10, s));
}
// Textual phase
function phaseText(s) {
  if (s <= 3.0) return '🔴 Oversold';
  if (s < 4.9) return '🔴 Bearish Incline';
  if (s < 6.0) return '🟠 Accumulation';
  if (s < 8.1) return '🟡 Bullish Incline';
  return '🟢 Overbought';
}

// In-memory persistence (per lambda instance)
const prevScores = {};
const prevPhases = {};
const alerts = [];

// API handler
enhancedHandler:
export default async function handler(req, res) {
  try {
    // Fetch CoinGecko top 100
    const cgRaw = await fetchWithFallback(COINGECKO);
    const cg = Array.isArray(cgRaw) ? cgRaw : [];

    // Fetch Binance Futures info
    const infoRaw = await fetchWithFallback(BINANCE_FUTURES_INFO);
    const symbolsList = Array.isArray(infoRaw.symbols) ? infoRaw.symbols : [];
    const futureSet = new Set(
      symbolsList
        .filter(s => s.contractType==='PERPETUAL' && s.symbol.endsWith('USDT'))
        .map(s => s.baseAsset)
    );

    // Filter assets: top100 non-stable, available in futures
    const assets = cg
      .filter(c => c.symbol && !STABLES.has(c.symbol.toUpperCase()))
      .map(c => ({ symbol: c.symbol.toUpperCase(), bin: c.symbol.toUpperCase()+'USDT', price: c.current_price }))
      .filter(a => futureSet.has(a.symbol));

    const result = [];
    for (let a of assets) {
      try {
        // 1d klines
        const day = await fetchWithFallback(`${BINANCE_KLINES}?symbol=${a.bin}&interval=1d&limit=10`);
        const { max, min } = getLastSundayMaxMin(day);
        // 15m
        const k15 = await fetchWithFallback(`${BINANCE_KLINES}?symbol=${a.bin}&interval=15m&limit=28`);
        const closes15 = Array.isArray(k15) ? k15.map(x=>+x[4]) : [];
        const ema28_15m = calcEMA(closes15,28);
        const rsi15m = calcRSI(closes15);
        // 5m
        const k5 = await fetchWithFallback(`${BINANCE_KLINES}?symbol=${a.bin}&interval=5m&limit=28`);
        const closes5 = Array.isArray(k5) ? k5.map(x=>+x[4]) : [];
        const ema28_5m = calcEMA(closes5,28);
        const rsi5m = calcRSI(closes5);
        // 4m
        const k4 = await fetchWithFallback(`${BINANCE_KLINES}?symbol=${a.bin}&interval=4m&limit=15`);
        const closes4 = Array.isArray(k4) ? k4.map(x=>+x[4]) : [];
        const rsi4m = calcRSI(closes4);

        // Compute
        const score = computeScore({ price: a.price, maxD: max, minD: min, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m });
        const phase = phaseText(score);

        // Alert on phase change
        const oldPhase = prevPhases[a.symbol];
        if (oldPhase && oldPhase !== phase) {
          alerts.unshift({ time: new Date().toLocaleTimeString(), symbol: a.symbol, oldPhase, newPhase: phase, price: a.price, score: score.toFixed(2) });
          if (alerts.length > 20) alerts.pop();
        }

        // Prev score default
        prevScores[a.symbol] = prevScores[a.symbol] || score;

        result.push({
          symbol: a.symbol,
          price: a.price,
          prevScore: prevScores[a.symbol].toFixed(2),
          score: score.toFixed(2),
          phase
        });

        prevScores[a.symbol] = score;
        prevPhases[a.symbol] = phase;

        // Throttle requests
        await new Promise(r=>setTimeout(r,200));
      } catch {
        result.push({ symbol: a.symbol, price: 0, prevScore: ((prevScores[a.symbol]||0).toFixed(2)), score: '0.00', phase: 'NoTrade' });
      }
    }

    return res.status(200).json({ data: result, alerts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
