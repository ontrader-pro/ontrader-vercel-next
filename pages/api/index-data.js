const BINANCE_FUTURES_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_KLINES       = 'https://fapi.binance.com/fapi/v1/klines';
const BINANCE_TICKER_24H   = 'https://fapi.binance.com/fapi/v1/ticker/24hr';

const STABLES = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'GUSD', 'USDN']);

function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  return arr.reduce((prev, v, i) => i ? v * k + prev * (1 - k) : v, 0);
}

function calcRSI(arr) {
  let gains = 0, losses = 0;
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d > 0) gains += d;
    else losses += -d;
  }
  const avgGain = gains / (arr.length - 1);
  const avgLoss = losses / (arr.length - 1) || 1e-6;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function fetchWithRetry(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 451) return [];
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

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

function computeScore({ price, max, min, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m }) {
  let s = 1;
  if (!isNaN(min) && price > min) s += 3;
  if (!isNaN(max) && price > max) s += 2;
  if (!isNaN(min) && price < min) s -= 2;
  if (rsi15m > 50 && price > ema28_15m) s += 2;
  if (rsi15m < 50 && price < ema28_15m) s -= 2;
  if (rsi5m > 70 && price > ema28_5m) s += 1;
  if (rsi5m < 30 && price < ema28_5m) s -= 1;
  if (rsi4m < 15) s += 0.5;
  if (rsi4m > 85) s -= 0.5;
  return Math.min(10, Math.max(1, s));
}

function phaseText(score) {
  if (score <= 3.0) return '🔴 Oversold';
  if (score < 4.9) return '🔴 Bearish Incline';
  if (score < 6.0) return '🟠 Accumulation';
  if (score < 8.1) return '🟡 Bullish Incline';
  return '🟢 Overbought';
}

export default async function (req, res) {
  try {
    const info = await fetchWithRetry(BINANCE_FUTURES_INFO);
    const ticker24h = await fetchWithRetry(BINANCE_TICKER_24H);

    if (!info || !Array.isArray(info.symbols)) {
      console.error('⚠️ Binance exchangeInfo no válido o symbols no disponible');
      return res.status(200).json({ results: [] });
    }
    if (!ticker24h || !Array.isArray(ticker24h)) {
      console.error('⚠️ Binance ticker24h no válido');
      return res.status(200).json({ results: [] });
    }

    const validAssets = info.symbols
      .filter(s =>
        s.contractType === 'PERPETUAL' &&
        s.symbol.endsWith('USDT') &&
        !STABLES.has(s.baseAsset)
      )
      .map(s => s.symbol);

    const ranked = ticker24h
      .filter(t => validAssets.includes(t.symbol))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 15)
      .map(t => t.symbol);

    const results = [];

    for (const symbol of ranked) {
      try {
        const candles15m = await fetchWithRetry(`${BINANCE_KLINES}?symbol=${symbol}&interval=15m&limit=28`);
        const candles5m  = await fetchWithRetry(`${BINANCE_KLINES}?symbol=${symbol}&interval=5m&limit=28`);
        const candles1m  = await fetchWithRetry(`${BINANCE_KLINES}?symbol=${symbol}&interval=1m&limit=4`);
        const candlesD   = await fetchWithRetry(`${BINANCE_KLINES}?symbol=${symbol}&interval=1d&limit=7`);

        const close15 = candles15m.map(c => parseFloat(c[4]));
        const close5  = candles5m.map(c => parseFloat(c[4]));
        const close1m = candles1m.map(c => parseFloat(c[4]));

        const ema28_15m = calcEMA(close15, 28);
        const ema28_5m  = calcEMA(close5, 28);
        const rsi15m    = calcRSI(close15);
        const rsi5m     = calcRSI(close5);
        const rsi4m     = calcRSI(close1m);

        const price = close1m[close1m.length - 1];
        const { max, min } = getLastSundayMaxMin(candlesD);

        const score = computeScore({ price, max, min, ema28_15m, rsi15m, ema28_5m, rsi5m, rsi4m });
        const phase = phaseText(score);

        results.push({ symbol, price, score, phase });

      } catch (err) {
        console.error(`❌ Error con ${symbol}:`, err.message);
      }
    }

    return res.status(200).json({ results });

  } catch (error) {
    console.error('❌ ERROR GLOBAL:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
