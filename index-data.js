// pages/api/index-data.js

const COINGECKO = 'https://api.coingecko.com/api/v3/coins/markets'
  + '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
const BINANCE_FUTURES_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_KLINES = 'https://fapi.binance.com/fapi/v1/klines';
const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','USDP','GUSD','USDN']);

// EMA
function calcEMA(arr, p) {
  const k = 2/(p+1);
  return arr.reduce((a,v,i)=> i ? v*k + a*(1-k) : v, 0);
}

// RSI
function calcRSI(arr) {
  let gains = 0, losses = 0;
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i-1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  const avgG = gains/(arr.length-1),
        avgL = losses/(arr.length-1) || 1e-6,
        rs = avgG/avgL;
  return 100 - (100/(1+rs));
}

// Encuentra el último domingo en las velas diarias
function getLastSundayMaxMin(klines) {
  for (let i = klines.length - 1; i >= 0; i--) {
    const date = new Date(klines[i][0]);
    if (date.getUTCDay() === 0) {
      return { max: Number(klines[i][2]), min: Number(klines[i][3]) };
    }
  }
  // fallback al último día disponible
  const last = klines[klines.length - 1];
  return { max: Number(last[2]), min: Number(last[3]) };
}

// Calcula el score jerárquico
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

// Determina la fase según el score
function phaseText(s) {
  if (s <= 3.0) return '🔴 Oversold';
  if (s < 4.9)   return '🔴 Bearish Incline';
  if (s < 6.0)   return '🟠 Accumulation';
  if (s < 8.1)   return '🟡 Bullish Incline';
  return           '🟢 Overbought';
}

export default async function handler(req, res) {
  try {
    // 1) Top 100 de CoinGecko (sin stablecoins)
    const cg = await fetch(COINGECKO).then(r => r.json());
    // 2) Info de Binance Futures
    const info = await fetch(BINANCE_FUTURES_INFO).then(r => r.json());
    const futureSet = new Set(
      info.symbols
        .filter(s => s.contractType === "PERPETUAL" && s.symbol.endsWith("USDT"))
        .map(s => s.baseAsset)
    );

    // 3) Filtrar y mapear assets
    const assets = cg
      .filter(c => c.symbol && !STABLES.has(c.symbol.toUpperCase()))
      .map(c => ({
        symbol: c.symbol.toUpperCase(),
        bin: c.symbol.toUpperCase() + 'USDT',
        price: c.current_price
      }))
      .filter(a => futureSet.has(a.symbol));

    // Historial en memoria (persistente mientras la función esté caliente)
    const prevScores = handler.prevScores || {};
    const prevPhases = handler.prevPhases || {};
    const alerts    = handler.alerts    || [];

    const result = [];
    for (const a of assets) {
      let score = 0, phase = '', oldPhase = prevPhases[a.symbol] || phase;
      try {
        // Velas diarias para domingo
        const day = await fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=1d&limit=10`).then(r => r.json());
        const { max, min } = getLastSundayMaxMin(day);
        // 15m
        const k15 = await fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=15m&limit=28`).then(r => r.json());
        const closes15 = k15.map(x => +x[4]);
        const ema28_15m = calcEMA(closes15, 28), rsi15m = calcRSI(closes15);
        // 5m
        const k5 = await fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=5m&limit=28`).then(r => r.json());
        const closes5 = k5.map(x => +x[4]);
        const ema28_5m = calcEMA(closes5, 28), rsi5m = calcRSI(closes5);
        // 4m
        const k4 = await fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=4m&limit=15`).then(r => r.json());
        const closes4 = k4.map(x => +x[4]);
        const rsi4m = calcRSI(closes4);
        // Score y fase
        score = computeScore({ price: a.price, maxD: max, minD: min,
                               ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m });
        phase = phaseText(score);
        // Alertas si cambia de fase
        if (oldPhase && oldPhase !== phase) {
          alerts.unshift({
            time: new Date().toLocaleTimeString(),
            symbol: a.symbol,
            oldPhase,
            newPhase: phase,
            price: a.price,
            score: score.toFixed(2)
          });
          if (alerts.length > 20) alerts.pop();
        }
        prevScores[a.symbol] = prevScores[a.symbol] || 0;
        result.push({
          symbol: a.symbol,
          price: a.price.toFixed(6),
          prevScore: prevScores[a.symbol].toFixed(2),
          score: score.toFixed(2),
          phase
        });
        prevScores[a.symbol] = score;
        prevPhases[a.symbol] = phase;

        // Pequeña pausa para evitar rate-limit
        await new Promise(r => setTimeout(r, 200));
      } catch {
        // Par no tradable o error
        result.push({
          symbol: a.symbol,
          price: '–',
          prevScore: prevScores[a.symbol]?.toFixed(2) || '–',
          score: '–',
          phase: 'NoTrade'
        });
      }
    }

    // Guardamos en la propia función (mientras esté caliente)
    handler.prevScores = prevScores;
    handler.prevPhases = prevPhases;
    handler.alerts    = alerts;

    res.status(200).json({ data: result, alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
