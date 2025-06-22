// pages/api/index-data.js

const COINGECKO = 
  'https://api.coingecko.com/api/v3/coins/markets'
  + '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
const BINANCE_FUTURES_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_KLINES       = 'https://fapi.binance.com/fapi/v1/klines';
const STABLES = new Set([
  'USDT','USDC','BUSD','DAI','TUSD','USDP','GUSD','USDN'
]);

function calcEMA(arr, p) {
  const k = 2/(p+1);
  return arr.reduce((a,v,i)=> i ? v*k + a*(1-k) : v, 0);
}

function calcRSI(arr) {
  let g=0,l=0;
  for(let i=1;i<arr.length;i++){
    const d=arr[i]-arr[i-1];
    if(d>0) g+=d; else l-=d;
  }
  const ag = g/(arr.length-1);
  const al = l/(arr.length-1)||1e-6;
  const rs = ag/al;
  return 100 - (100/(1+rs));
}

function getLastSundayMaxMin(klines) {
  for(let i=klines.length-1; i>=0; i--) {
    const day = new Date(klines[i][0]);
    if (day.getUTCDay() === 0) {
      return { 
        max: Number(klines[i][2]), 
        min: Number(klines[i][3]) 
      };
    }
  }
  // fallback si no hay domingo
  const last = klines[klines.length-1];
  return {
    max: Number(last[2]),
    min: Number(last[3])
  };
}

function computeScore({ price, maxD, minD, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m }) {
  let s = 1;
  // Jerarquía 1: día domingo
  if (price > minD) s += 3;
  if (price > maxD) s += 2;
  if (price < minD) s -= 2;
  // Jerarquía 2: 15m
  if (rsi15m > 50 && price > ema28_15m) s += 2;
  if (rsi15m < 50 && price < ema28_15m) s -= 2;
  // Jerarquía 3: 5m
  if (rsi5m > 70 && price > ema28_5m) s += 1;
  if (rsi5m < 30 && price < ema28_5m) s -= 1;
  // Jerarquía 4: 4m
  if (rsi4m < 15) s += 0.5;
  if (rsi4m > 85) s -= 0.5;
  // limita entre 1 y 10
  return Math.max(1, Math.min(10, s));
}

function phaseText(score) {
  if (score <= 3.0)    return '🔴 Oversold';
  if (score < 4.9)     return '🔴 Bearish Incline';
  if (score < 6.0)     return '🟠 Accumulation';
  if (score < 8.1)     return '🟡 Bullish Incline';
  return '🟢 Overbought';
}

// Estado en memoria de la Lambda
// (sobrevive mientras la función esté "caliente")
handler.prevScores  ||= {};
handler.prevPhases  ||= {};
handler.alerts      ||= [];

export default async function handler(req, res) {
  try {
    // 1) Top 100 de CoinGecko
    const cg = await fetch(COINGECKO).then(r=>r.json());

    // 2) Información de futuros en Binance
    const info = await fetch(BINANCE_FUTURES_INFO).then(r=>r.json());
    const futureSet = new Set(
      info.symbols
        .filter(s=>s.contractType==='PERPETUAL' && s.symbol.endsWith('USDT'))
        .map(s=>s.baseAsset)
    );

    // 3) Filtrar y mapear activos
    const assets = cg
      .filter(c=>c.symbol && !STABLES.has(c.symbol.toUpperCase()))
      .map(c=>({
        symbol: c.symbol.toUpperCase(),
        bin:    c.symbol.toUpperCase()+'USDT',
        price:  c.current_price
      }))
      .filter(a=>futureSet.has(a.symbol));

    const result = [];
    const alerts = handler.alerts;
    const prevScores = handler.prevScores;
    const prevPhases = handler.prevPhases;

    // 4) Para cada activo, fetch de klines y cálculo
    for (const a of assets) {
      let score, phase;
      try {
        // Klines 1d (últimos 10 días)
        const dayK = await fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=1d&limit=10`).then(r=>r.json());
        const { max, min } = getLastSundayMaxMin(dayK);

        // Klines 15m
        const k15 = await fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=15m&limit=28`).then(r=>r.json());
        const close15 = k15.map(x=>+x[4]);
        const ema28_15m = calcEMA(close15,28);
        const rsi15m    = calcRSI(close15);

        // Klines 5m
        const k5 = await fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=5m&limit=28`).then(r=>r.json());
        const close5 = k5.map(x=>+x[4]);
        const ema28_5m = calcEMA(close5,28);
        const rsi5m    = calcRSI(close5);

        // Klines 4m
        const k4 = await fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=4m&limit=15`).then(r=>r.json());
        const close4 = k4.map(x=>+x[4]);
        const rsi4m  = calcRSI(close4);

        // Score y fase
        score = computeScore({
          price: a.price,
          maxD:  max,
          minD:  min,
          ema28_15m, rsi15m,
          ema28_5m,  rsi5m,
          rsi4m
        });
        phase = phaseText(score);

        // Registrar alerta si hubo cambio de fase
        if (prevPhases[a.symbol] && prevPhases[a.symbol] !== phase) {
          alerts.unshift({
            time:       new Date().toLocaleTimeString(),
            symbol:     a.symbol,
            oldPhase:   prevPhases[a.symbol],
            newPhase:   phase,
            price:      a.price,
            score:      score.toFixed(2)
          });
          if (alerts.length > 20) alerts.pop();
        }

        // Guardar previos en memoria
        prevScores[a.symbol] = prevScores[a.symbol] || 0;
        prevPhases[a.symbol] = phase;

        result.push({
          symbol:     a.symbol,
          price:      a.price.toFixed(6),
          prevScore:  prevScores[a.symbol].toFixed(2),
          score:      score.toFixed(2),
          phase
        });

        // Actualizar prevScores para la próxima llamada
        prevScores[a.symbol] = score;

      } catch {
        // Si falla cualquier fetch o cálculo
        result.push({
          symbol:    a.symbol,
          price:     '–',
          prevScore: prevScores[a.symbol]?.toFixed(2) || '–',
          score:     '–',
          phase:     'NoTrade'
        });
      }
      // Pequeña pausa para no saturar Binance
      await new Promise(r => setTimeout(r, 200));
    }

    // Actualizar el estado de la función
    handler.alerts     = alerts;
    handler.prevScores = prevScores;
    handler.prevPhases = prevPhases;

    return res.status(200).json({ data: result, alerts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
