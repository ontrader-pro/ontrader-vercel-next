// pages/api/index-data.js
import fetch from 'node-fetch';

const COINGECKO = 'https://api.coingecko.com/api/v3/coins/markets'
  + '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
const BINANCE_FUTURES_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_KLINES = 'https://fapi.binance.com/fapi/v1/klines';
const ALLORIGINS = 'https://api.allorigins.win/raw?url=';
const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','USDP','GUSD','USDN']);

function calcEMA(arr, p) {
  const k = 2/(p+1);
  return arr.reduce((a,v,i) => i ? v*k + a*(1-k) : v, 0);
}
function calcRSI(arr) {
  let g=0, l=0;
  for (let i=1; i<arr.length; i++) {
    const d = arr[i] - arr[i-1];
    d>0 ? g+=d : l-=d;
  }
  const ag=g/(arr.length-1), al=l/(arr.length-1)||1e-6, rs=ag/al;
  return 100 - (100/(1+rs));
}
async function fetchWithFallback(url, tries=2) {
  for (let i=0; i<=tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 451) throw new Error('451');
        throw new Error(`Status ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      if (e.message === '451' && i===0) {
        // Fallback via allorigins
        url = ALLORIGINS + encodeURIComponent(url);
        continue;
      }
      if (i === tries) throw e;
      await new Promise(r => setTimeout(r, 600 + 400*i));
    }
  }
}

function getLastSundayMaxMin(klines) {
  for (let i=klines.length-1; i>=0; i--) {
    if (new Date(klines[i][0]).getUTCDay() === 0) {
      return { max: +klines[i][2], min: +klines[i][3] };
    }
  }
  const k = klines[klines.length-1];
  return { max: +k[2], min: +k[3] };
}
function computeScore({ price, maxD, minD, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m }) {
  let s = 1;
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
function phaseText(s) {
  if (s <= 3.0) return '🔴 Oversold';
  if (s < 4.9) return '🔴 Bearish Incline';
  if (s < 6.0) return '🟠 Accumulation';
  if (s < 8.1) return '🟡 Bullish Incline';
  return '🟢 Overbought';
}

// In-memory persistence per lambda instance
const prevScores = {};
const prevPhases = {};
const alerts = [];

export default async function handler(req, res) {
  try {
    const cg = await fetchWithFallback(COINGECKO);
    const info = await fetchWithFallback(BINANCE_FUTURES_INFO);
    const futureSet = new Set(
      info.symbols.filter(s => s.contractType==='PERPETUAL'&&s.symbol.endsWith('USDT'))
                  .map(s => s.baseAsset)
    );

    const assets = cg
      .filter(c => c.symbol && !STABLES.has(c.symbol.toUpperCase()))
      .map(c => ({ symbol: c.symbol.toUpperCase(), bin: c.symbol.toUpperCase()+'USDT', price: c.current_price }))
      .filter(a => futureSet.has(a.symbol));

    const result = [];
    for (let a of assets) {
      try {
        const day = await fetchWithFallback(`${BINANCE_KLINES}?symbol=${a.bin}&interval=1d&limit=10`);
        const {max, min} = getLastSundayMaxMin(day);
        const k15 = await fetchWithFallback(`${BINANCE_KLINES}?symbol=${a.bin}&interval=15m&limit=28`);
        const closes15 = k15.map(x=>+x[4]);
        const ema28_15m = calcEMA(closes15, 28), rsi15m = calcRSI(closes15);
        const k5 = await fetchWithFallback(`${BINANCE_KLINES}?symbol=${a.bin}&interval=5m&limit=28`);
        const closes5 = k5.map(x=>+x[4]);
        const ema28_5m = calcEMA(closes5, 28), rsi5m = calcRSI(closes5);
        const k4 = await fetchWithFallback(`${BINANCE_KLINES}?symbol=${a.bin}&interval=4m&limit=15`);
        const closes4 = k4.map(x=>+x[4]);
        const rsi4m = calcRSI(closes4);

        const score = computeScore({ price: a.price, maxD: max, minD: min, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m });
        const phase = phaseText(score);
        const oldPhase = prevPhases[a.symbol];
        if (oldPhase && oldPhase !== phase) {
          alerts.unshift({ time: new Date().toLocaleTimeString(), symbol: a.symbol, oldPhase, newPhase: phase, price: a.price, score: score.toFixed(2) });
          if (alerts.length > 20) alerts.pop();
        }
        prevScores[a.symbol] = prevScores[a.symbol] || 0;
        result.push({ symbol: a.symbol, price: a.price, prevScore: prevScores[a.symbol].toFixed(2), score: score.toFixed(2), phase });
        prevScores[a.symbol] = score;
        prevPhases[a.symbol] = phase;
        await new Promise(r=>setTimeout(r, 200));
      } catch (_) {
        result.push({ symbol: a.symbol, price: 0, prevScore: (prevScores[a.symbol]||0).toFixed(2), score: '0.00', phase: 'NoTrade' });
      }
    }

    res.status(200).json({ data: result, alerts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
