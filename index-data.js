// pages/api/index-data.js
import fetch from 'node-fetch';

const COINGECKO = 'https://api.coingecko.com/api/v3/coins/markets'
  + '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
const BINANCE_FUTURES_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_KLINES = 'https://fapi.binance.com/fapi/v1/klines';
const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','USDP','GUSD','USDN']);

function calcEMA(arr, p){
  const k = 2/(p+1);
  return arr.reduce((a,v,i)=> i? v*k + a*(1-k) : v, 0);
}
function calcRSI(arr){
  let g=0,l=0;
  for(let i=1;i<arr.length;i++){
    const d=arr[i]-arr[i-1];
    if(d>0) g+=d; else l-=d;
  }
  const ag=g/(arr.length-1), al=l/(arr.length-1)||1e-6, rs=ag/al;
  return 100 - 100/(1+rs);
}
function getLastSundayMaxMin(klines){
  for(let i=klines.length-1;i>=0;i--){
    const d=new Date(klines[i][0]);
    if(d.getUTCDay()===0) return {
      max: Number(klines[i][2]),
      min: Number(klines[i][3])
    };
  }
  const k=klines[klines.length-1];
  return { max: Number(k[2]), min: Number(k[3]) };
}
function computeScore({ price, maxD, minD, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m }){
  let s=1;
  if (price>minD) s+=3;
  if (price>maxD) s+=2;
  if (price<minD) s-=2;
  if (rsi15m>50 && price>ema28_15m) s+=2;
  if (rsi15m<50 && price<ema28_15m) s-=2;
  if (rsi5m>70 && price>ema28_5m) s+=1;
  if (rsi5m<30 && price<ema28_5m) s-=1;
  if (rsi4m<15) s+=0.5;
  if (rsi4m>85) s-=0.5;
  return Math.max(1, Math.min(10, s));
}
function phaseText(s){
  if(s<=3) return '🔴 Oversold';
  if(s<4.9) return '🔴 Bearish Incline';
  if(s<6) return '🟠 Accumulation';
  if(s<8.1) return '🟡 Bullish Incline';
  return '🟢 Overbought';
}

export default async function handler(req, res) {
  try {
    // 1) Top100 CG
    const cg = await (await fetch(COINGECKO)).json();
    // 2) Futuros en Binance
    const info = await (await fetch(BINANCE_FUTURES_INFO)).json();
    const futureSet = new Set(info.symbols
      .filter(s=>s.contractType==='PERPETUAL'&&s.symbol.endsWith('USDT'))
      .map(s=>s.baseAsset));
    // 3) Filtrar assets
    const assets = cg
      .filter(c=>c.symbol && !STABLES.has(c.symbol.toUpperCase()))
      .map(c=>({
        symbol: c.symbol.toUpperCase(),
        bin: c.symbol.toUpperCase()+'USDT',
        price: c.current_price
      }))
      .filter(a=>futureSet.has(a.symbol));
    // Historial (en memoria del servidorless mientras viva)
    const prevScores = handler.prevScores || {};
    const prevPhases = handler.prevPhases || {};
    const alerts = (handler.alerts||[]);

    const result = [];
    for(const a of assets){
      let score=0, phase='';
      try {
        // klines 1d
        const day = await (await fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=1d&limit=10`)).json();
        const {max,min} = getLastSundayMaxMin(day);
        // 15m
        const k15=await (await fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=15m&limit=28`)).json();
        const closes15=k15.map(x=>+x[4]);
        const ema28_15=calcEMA(closes15,28), rsi15=calcRSI(closes15);
        // 5m
        const k5=await (await fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=5m&limit=28`)).json();
        const closes5=k5.map(x=>+x[4]);
        const ema28_5=calcEMA(closes5,28), rsi5=calcRSI(closes5);
        // 4m
        const k4=await (await fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=4m&limit=15`)).json();
        const closes4=k4.map(x=>+x[4]);
        const rsi4=calcRSI(closes4);
        // score + fase
        score = computeScore({
          price:a.price, maxD:max, minD:min,
          ema28_15m:ema28_15, rsi15m:rsi15,
          ema28_5m:ema28_5, rsi5m:rsi5,
          rsi4m:rsi4
        });
        phase = phaseText(score);
        // alertas
        if(prevPhases[a.symbol] && prevPhases[a.symbol]!==phase){
          alerts.unshift({
            time: new Date().toLocaleTimeString(),
            symbol: a.symbol,
            oldPhase: prevPhases[a.symbol],
            newPhase: phase,
            price: a.price,
            score: score.toFixed(2)
          });
          if(alerts.length>20) alerts.pop();
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
        await new Promise(r=>setTimeout(r,200)); // throttle
      } catch {
        result.push({
          symbol:a.symbol, price:'–',
          prevScore:'–', score:'–',
          phase:'NoTrade'
        });
      }
    }

    // Guardar en memoria (persistente en la lambda mientras esté viva)
    handler.prevScores = prevScores;
    handler.prevPhases = prevPhases;
    handler.alerts = alerts;

    res.status(200).json({ data: result, alerts });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}
