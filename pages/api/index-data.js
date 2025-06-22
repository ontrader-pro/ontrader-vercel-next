const COINGECKO =
  'https://api.coingecko.com/api/v3/coins/markets'
  + '?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false'; // reducido a top 50
const BINANCE_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_KLINES = 'https://fapi.binance.com/fapi/v1/klines';
const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','USDP','GUSD','USDN']);

function calcEMA(arr, p) {
  const k = 2/(p+1);
  return arr.reduce((a,v,i)=> i? v*k + a*(1-k) : v, 0);
}
function calcRSI(arr) {
  let g=0, l=0;
  for(let i=1;i<arr.length;i++){
    const d=arr[i]-arr[i-1];
    if(d>0) g+=d; else l-=d;
  }
  const ag=g/(arr.length-1);
  const al=l/(arr.length-1)||1e-6;
  return 100 - 100/(1+ag/al);
}
function getLastSundayMaxMin(kl) {
  for(let i=kl.length-1;i>=0;i--){
    const d=new Date(kl[i][0]);
    if(d.getUTCDay()===0) return { max:+kl[i][2], min:+kl[i][3] };
  }
  const last=kl[kl.length-1];
  return { max:+last[2], min:+last[3] };
}
function computeScore({price,maxD,minD,ema15,rsi15,ema5,rsi5,rsi4}) {
  let s=1;
  if(price>minD) s+=3;
  if(price>maxD) s+=2;
  if(price<minD) s-=2;
  if(rsi15>50 && price>ema15) s+=2;
  if(rsi15<50 && price<ema15) s-=2;
  if(rsi5>70 && price>ema5) s+=1;
  if(rsi5<30 && price<ema5) s-=1;
  if(rsi4<15) s+=0.5;
  if(rsi4>85) s-=0.5;
  return Math.max(1, Math.min(10, s));
}
function phaseText(s) {
  if(s<=3) return '🔴 Oversold';
  if(s<4.9) return '🔴 Bearish Incline';
  if(s<6) return '🟠 Accumulation';
  if(s<8.1) return '🟡 Bullish Incline';
  return '🟢 Overbought';
}

// Persistencia en memoria (mientras la lambda esté caliente)
handler.prevScores = handler.prevScores || {};
handler.prevPhases = handler.prevPhases || {};
handler.alerts = handler.alerts || [];

export default async function handler(req, res) {
  try {
    const [cg, info] = await Promise.all([
      fetch(COINGECKO).then(r=>r.json()),
      fetch(BINANCE_INFO).then(r=>r.json())
    ]);
    const futureSet = new Set(
      info.symbols
        .filter(s=>s.contractType==='PERPETUAL'&&s.symbol.endsWith('USDT'))
        .map(s=>s.baseAsset)
    );
    const assets = cg
      .filter(c=>c.symbol && !STABLES.has(c.symbol.toUpperCase()))
      .map(c=>({ sym: c.symbol.toUpperCase(), bin: c.symbol.toUpperCase()+'USDT', pr: c.current_price }))
      .filter(a=>futureSet.has(a.sym));

    const result = [];
    // Procesar en batches de 10 para limitar concurrencia
    for (let i = 0; i < assets.length; i += 10) {
      const batch = assets.slice(i, i + 10);
      const batchData = await Promise.all(batch.map(async a => {
        try {
          const [kl1d, kl15, kl5, kl4] = await Promise.all([
            fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=1d&limit=10`).then(r=>r.json()),
            fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=15m&limit=28`).then(r=>r.json()),
            fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=5m&limit=28`).then(r=>r.json()),
            fetch(`${BINANCE_KLINES}?symbol=${a.bin}&interval=4m&limit=15`).then(r=>r.json())
          ]);
          const { max, min } = getLastSundayMaxMin(kl1d);
          const c15 = kl15.map(x=>+x[4]), e15 = calcEMA(c15,28), r15 = calcRSI(c15);
          const c5  = kl5.map(x=>+x[4]), e5  = calcEMA(c5,28), r5  = calcRSI(c5);
          const r4  = calcRSI(kl4.map(x=>+x[4]));
          const sc = computeScore({ price:a.pr, maxD:max, minD:min, ema15:e15, rsi15:r15, ema5:e5, rsi5:r5, rsi4:r4 });
          const ph = phaseText(sc);
          const old = handler.prevPhases[a.sym] || ph;
          if(old !== ph) {
            handler.alerts.unshift({ time: new Date().toLocaleTimeString(), symbol: a.sym, oldPhase: old, newPhase: ph, price: a.pr, score: sc.toFixed(2) });
            handler.alerts = handler.alerts.slice(0,20);
          }
          const prev = handler.prevScores[a.sym] || 0;
          handler.prevScores[a.sym] = sc;
          handler.prevPhases[a.sym] = ph;
          return { symbol: a.sym, price: a.pr.toFixed(6), prevScore: prev.toFixed(2), score: sc.toFixed(2), phase: ph };
        } catch {
          return { symbol: a.sym, price: '–', prevScore: '–', score: '–', phase: 'NoTrade' };
        }
      }));
      result.push(...batchData);
    }

    res.status(200).json({ data: result, alerts: handler.alerts });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}
