// pages/api/index-data.js
const COINGECKO = 'https://api.coingecko.com/api/v3/coins/markets'
  + '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
const BINANCE_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_KLINES = 'https://fapi.binance.com/fapi/v1/klines';
const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','USDP','GUSD','USDN']);

function calcEMA(arr, p) {
  const k = 2/(p+1);
  return arr.reduce((a,v,i)=>i? v*k + a*(1-k): v, 0);
}
function calcRSI(arr) {
  let gains=0, losses=0;
  for(let i=1;i<arr.length;i++){
    const d = arr[i]-arr[i-1];
    if(d>0) gains+=d; else losses-=d;
  }
  const avgG = gains/(arr.length-1);
  const avgL = (losses/(arr.length-1))||1e-6;
  const rs = avgG/avgL;
  return 100 - (100/(1+rs));
}
function getLastSundayMaxMin(klines) {
  for(let i=klines.length-1;i>=0;i--){
    const day = new Date(klines[i][0]);
    if(day.getUTCDay()===0) {
      return { max: +klines[i][2], min: +klines[i][3] };
    }
  }
  // fallback al último día disponible
  const last = klines[klines.length-1];
  return { max:+last[2], min:+last[3] };
}
function computeScore({ price, maxD, minD, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m }) {
  let s = 1;
  if(price>minD) s+=3;
  if(price>maxD) s+=2;
  if(price<minD) s-=2;
  if(rsi15m>50 && price>ema28_15m) s+=2;
  if(rsi15m<50 && price<ema28_15m) s-=2;
  if(rsi5m>70 && price>ema28_5m) s+=1;
  if(rsi5m<30 && price<ema28_5m) s-=1;
  if(rsi4m<15) s+=0.5;
  if(rsi4m>85) s-=0.5;
  return Math.max(1, Math.min(10, s));
}
function phaseText(s) {
  if(s<=3) return '🔴 Oversold';
  if(s<4.9) return '🔴 Bearish Incline';
  if(s<6) return '🟠 Accumulation';
  if(s<8.1) return '🟡 Bullish Incline';
  return '🟢 Overbought';
}

export default async function handler(req, res) {
  try {
    // ——— 1) TOP 100 COINGECKO ———
    const cgResp = await fetch(COINGECKO);
    if(!cgResp.ok) throw new Error(`CoinGecko ${cgResp.status}`);
    const cgData = await cgResp.json();
    const cgList = Array.isArray(cgData) ? cgData : [];

    // ——— 2) BINANCE FUTURES INFO ———
    const infoResp = await fetch(BINANCE_INFO);
    if(!infoResp.ok) throw new Error(`BinanceInfo ${infoResp.status}`);
    const infoData = await infoResp.json();
    const symbolsArr = Array.isArray(infoData.symbols) ? infoData.symbols : [];
    const futureBaseSet = new Set(
      symbolsArr
        .filter(s=> s.contractType==='PERPETUAL' && s.symbol.endsWith('USDT'))
        .map(s=>s.baseAsset)
    );

    // ——— 3) FILTRAR assets válidas ———
    const assets = cgList
      .filter(c=> c.symbol && !STABLES.has(c.symbol.toUpperCase()))
      .map(c=>({
        symbol: c.symbol.toUpperCase(),
        binSymbol: c.symbol.toUpperCase()+'USDT',
        price: c.current_price
      }))
      .filter(a=> futureBaseSet.has(a.symbol));

    // Memoria en lambda (sigue viva mientras no expira)
    handler.prevScores = handler.prevScores || {};
    handler.prevPhases = handler.prevPhases || {};
    handler.alerts     = handler.alerts     || [];

    const result = [];
    for(const a of assets) {
      let score=0, phase='', prevScore = handler.prevScores[a.symbol] || 0;
      try {
        // Velas 1d
        const dayK = await (await fetch(`${BINANCE_KLINES}?symbol=${a.binSymbol}&interval=1d&limit=10`)).json();
        const { max, min } = getLastSundayMaxMin(Array.isArray(dayK)?dayK:[]);

        // Velas 15m
        const k15 = await (await fetch(`${BINANCE_KLINES}?symbol=${a.binSymbol}&interval=15m&limit=28`)).json();
        const c15 = (Array.isArray(k15)?k15:[]).map(x=>+x[4]);
        const ema28_15m = calcEMA(c15,28), rsi15m = calcRSI(c15);

        // Velas 5m
        const k5 = await (await fetch(`${BINANCE_KLINES}?symbol=${a.binSymbol}&interval=5m&limit=28`)).json();
        const c5 = (Array.isArray(k5)?k5:[]).map(x=>+x[4]);
        const ema28_5m = calcEMA(c5,28), rsi5m = calcRSI(c5);

        // Velas 4m
        const k4 = await (await fetch(`${BINANCE_KLINES}?symbol=${a.binSymbol}&interval=4m&limit=15`)).json();
        const c4 = (Array.isArray(k4)?k4:[]).map(x=>+x[4]);
        const rsi4m = calcRSI(c4);

        // Score + Phase
        score = computeScore({ price:a.price, maxD:max, minD:min,
          ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m
        });
        phase = phaseText(score);

        // Alerta si cambió de fase
        const oldPhase = handler.prevPhases[a.symbol];
        if(oldPhase && oldPhase !== phase) {
          handler.alerts.unshift({
            time: new Date().toLocaleTimeString(),
            symbol: a.symbol,
            oldPhase, newPhase: phase,
            price: a.price, score: score.toFixed(2)
          });
          handler.alerts = handler.alerts.slice(0,20);
        }

        handler.prevScores[a.symbol] = score;
        handler.prevPhases[a.symbol] = phase;
      } catch(e) {
        phase = 'NoTrade';
      }

      result.push({
        symbol: a.symbol,
        price: a.price.toFixed(6),
        prevScore: prevScore.toFixed(2),
        score: score.toFixed(2),
        phase
      });

      // Muy ligera pausa para no saturar la API
      await new Promise(r=>setTimeout(r, 200));
    }

    // Respuesta JSON
    res.status(200).json({
      data: result,
      alerts: handler.alerts
    });
  } catch(err) {
    console.error('API error:', err);
    res.status(500).json({ error: err.message });
  }
}
