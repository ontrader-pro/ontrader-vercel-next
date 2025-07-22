 `pages/api/index-data.js`
```js
import fetch from 'node-fetch';

// CoinGecko: top 100 (sin sparkline)
const COINGECKO =
  'https://api.coingecko.com/api/v3/coins/markets'
  + '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
// Binance Futures
const BINANCE_FUTURES_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_KLINES      = 'https://fapi.binance.com/fapi/v1/klines';
// Excluir stablecoins
const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','USDP','GUSD','USDN']);

// Cálculo de EMA
function calcEMA(arr, period) {
  const k = 2/(period+1);
  return arr.reduce((prev, v, i)=> i? v*k + prev*(1-k) : v, 0);
}
// Cálculo de RSI
function calcRSI(arr) {
  let gains=0, losses=0;
  for(let i=1;i<arr.length;i++){
    const d = arr[i]-arr[i-1];
    if(d>0) gains+=d; else losses-=d;
  }
  const ag=gains/(arr.length-1), al=losses/(arr.length-1)||1e-6, rs=ag/al;
  return 100 - 100/(1+rs);
}
// Fetch con retry y manejo 451
async function fetchWithRetry(url, retries=2) {
  for(let i=0;i<=retries;i++){
    try {
      const res = await fetch(url);
      if(res.status===451) return [];  // no-fatal
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch(e) {
      if(i===retries) throw e;
      await new Promise(r=>setTimeout(r,500 + i*500));
    }
  }
}
// Último domingo max/min
def getLastSundayMaxMin(klines) {
  if(!Array.isArray(klines)||klines.length===0) return {max:NaN,min:NaN};
  for(let i=klines.length-1;i>=0;i--){
    const d=new Date(klines[i][0]);
    if(d.getUTCDay()===0) return { max:+klines[i][2], min:+klines[i][3] };
  }
  const last=klines.at(-1);
  return { max:+last[2], min:+last[3] };
}
// Score jerárquico
def computeScore({ price, maxD, minD, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m }) {
  let s=1;
  if(!isNaN(minD) && price>minD) s+=3;
  if(!isNaN(maxD) && price>maxD) s+=2;
  if(!isNaN(minD) && price<minD) s-=2;
  if(rsi15m>50 && price>ema28_15m) s+=2;
  if(rsi15m<50 && price<ema28_15m) s-=2;
  if(rsi5m>70 && price>ema28_5m) s+=1;
  if(rsi5m<30 && price<ema28_5m) s-=1;
  if(rsi4m<15) s+=0.5;
  if(rsi4m>85) s-=0.5;
  return Math.max(1, Math.min(10, s));
}
// Etiqueta de fase
def phaseText(score) {
  if(score<=3.0) return '🔴 Oversold';
  if(score<4.9)  return '🔴 Bearish Incline';
  if(score<6.0)  return '🟠 Accumulation';
  if(score<8.1)  return '🟡 Bullish Incline';
  return '🟢 Overbought';
}

// Estado en memoria (warm lambdas)
const prevScores = {};
const prevPhases = {};
let alertHistory = [];

export default async function handler(req, res) {
  try {
    const cgList = await fetchWithRetry(COINGECKO);
    const info   = await fetchWithRetry(BINANCE_FUTURES_INFO);
    const validF = new Set(
      info.symbols
        .filter(s=>s.contractType==='PERPETUAL'&&s.symbol.endsWith('USDT'))
        .map(s=>s.baseAsset)
    );

    const assets = cgList
      .filter(c=>c.symbol)
      .map(c=>({ symbol:c.symbol.toUpperCase(), bin:c.symbol.toUpperCase()+'USDT', price:c.current_price }))
      .filter(a=>validF.has(a.symbol)&&!STABLES.has(a.symbol));

    const data = [];
    for(const a of assets) {
      let score=0, phase='NoTrade';
      const prev=prevScores[a.symbol]||0;
      try {
        const day = await fetchWithRetry(`${BINANCE_KLINES}?symbol=${a.bin}&interval=1d&limit=10`);
        const {max:minD, min: minD} = getLastSundayMaxMin(day);
        const k15=await fetchWithRetry(`${BINANCE_KLINES}?symbol=${a.bin}&interval=15m&limit=28`);
        const closes15=k15.map(x=>+x[4]);
        const ema28_15m=calcEMA(closes15,28), rsi15m=calcRSI(closes15);
        const k5 = await fetchWithRetry(`${BINANCE_KLINES}?symbol=${a.bin}&interval=5m&limit=28`);
        const closes5=k5.map(x=>+x[4]);
        const ema28_5m=calcEMA(closes5,28), rsi5m=calcRSI(closes5);
        const k4 = await fetchWithRetry(`${BINANCE_KLINES}?symbol=${a.bin}&interval=4m&limit=15`);
        const closes4=k4.map(x=>+x[4]);
        const rsi4m=calcRSI(closes4);
        score = computeScore({ price:a.price, maxD, minD, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m });
        phase = phaseText(score);
        const old=prevPhases[a.symbol];
        if(old&&old!==phase){
          alertHistory.unshift({ time:new Date().toLocaleTimeString(), symbol:a.symbol, oldPhase:old, newPhase:phase, price:a.price, score:score.toFixed(2) });
          if(alertHistory.length>20) alertHistory.pop();
        }
        prevScores[a.symbol]=score;
        prevPhases[a.symbol]=phase;
      } catch(_){}
      data.push({ symbol:a.symbol, price:+a.price.toFixed(6), prevScore:prev.toFixed(2), score:score.toFixed(2), phase });
      await new Promise(r=>setTimeout(r,150));
    }

    res.status(200).json({ data, alerts:alertHistory, formula:{ base:1, clamp:[1,10], hierarchy:[ /* weights same que arriba */ ] }});
  } catch(err) {
    res.status(500).json({ error:err.message });
  }
}
```
