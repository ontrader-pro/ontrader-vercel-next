import fetch from 'node-fetch';

// CoinGecko: top 100 (sin sparkline)
const COINGECKO =
  'https://api.coingecko.com/api/v3/coins/markets'
  + '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
// Binance Futures endpoints
const BINANCE_FUTURES_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_KLINES      = 'https://fapi.binance.com/fapi/v1/klines';
// Excluir stablecoins
const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','USDP','GUSD','USDN']);

// Cálculo de EMA en un array de cierres
function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  return arr.reduce((prev, v, i) => i ? v * k + prev * (1 - k) : v, 0);
}

// Cálculo de RSI en un array de cierres
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

// Fetch con retry en caso de error leve\async function fetchWithRetry(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 451) return [];
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

// Extrae máximo y mínimo de domingo de las velas diarias
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

// Calcula el score según jerarquía y límites entre 1 y 10
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

// Traduce score a fase
function phaseText(score) {
  if (score <= 3.0) return '🔴 Oversold';
  if (score < 4.9) return '🔴 Bearish Incline';
  if (score < 6.0) return '🟠 Accumulation';
  if (score < 8.1) return '🟡 Bullish Incline';
  return '🟢 Overbought';
}

// Estado en memoria de la lambda entre llamadas
const prevScores = {};
const prevPhases = {};
let alertHistory = [];

export default async function handler(req, res) {
  try {
    // 1) Top100 de CoinGecko
    const cgList = await fetchWithRetry(COINGECKO);
    // 2) Info de futuros Binance
    const info = await fetchWithRetry(BINANCE_FUTURES_INFO);
    const validF = new Set(
      info.symbols
        .filter(s => s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
        .map(s => s.baseAsset)
    );