/*
 * Momentum Desk — Yahoo Prices Worker (v2, batch)
 *
 * פריסה: להחליף את הקוד של ה-Worker הקיים (momentum-yahoo-prices) בקוד הזה.
 * ראה worker/README.md להוראות.
 *
 * נקודות קצה:
 *   GET /?symbol=NVDA              — תאימות לאחור: אובייקט יחיד (שדות זהים לגרסה הקודמת + שדות חדשים)
 *   GET /?symbols=NVDA,AMD,VRT,... — batch: עד 32 סימבולים בבקשה אחת, מחזיר {quotes:{SYM:{...}},errors:{}}
 *                                    (32 ציטוטים + עד 15 משיכות avgVol = 47 subrequests, מתחת למגבלת 50 של התוכנית החינמית)
 *
 * שדות לכל סימבול:
 *   price, regularMarketPrice, previousClose, preMarketPrice, postMarketPrice,
 *   extendedPrice, time, open, dayHigh, dayLow, volume, avgVol10d, marketState
 *
 * avgVol10d (נפח ממוצע 10 ימים, לחישוב RVOL) נשמר ב-Cache API ל-6 שעות כדי לחסוך
 * subrequests. תקציב של עד 15 משיכות avgVol חדשות לבקשה — השאר מתמלאים ברענונים הבאים.
 */

const YF = "https://query1.finance.yahoo.com/v8/finance/chart/";
const UA = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "content-type": "application/json;charset=utf-8",
  "cache-control": "no-store"
};

async function chart(sym, qs) {
  const r = await fetch(YF + encodeURIComponent(sym) + "?" + qs, { headers: UA });
  if (!r.ok) throw new Error("yahoo HTTP " + r.status);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(j?.chart?.error?.description || "no chart result");
  return res;
}

function lastFinite(arr) {
  if (!Array.isArray(arr)) return { v: null, i: -1 };
  for (let i = arr.length - 1; i >= 0; i--) {
    const x = arr[i];
    if (Number.isFinite(x) && x > 0) return { v: x, i };
  }
  return { v: null, i: -1 };
}

function nyDay(tsSec) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(tsSec * 1000));
}

/* נפח ממוצע 10 ימי מסחר אחרונים (ללא היום החלקי), עם קאש של 6 שעות */
async function avgVol10d(sym, budget, ctx) {
  const cacheKey = new Request("https://momentum-cache.invalid/avgvol/" + encodeURIComponent(sym));
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    try { const d = await hit.json(); if (Number.isFinite(d.av)) return d.av; } catch (e) {}
  }
  if (budget.left <= 0) return null;
  budget.left--;
  const res = await chart(sym, "range=1mo&interval=1d");
  const ts = res.timestamp || [];
  const vols = res.indicators?.quote?.[0]?.volume || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    if (Number.isFinite(vols[i]) && vols[i] > 0) rows.push({ t: ts[i], v: vols[i] });
  }
  const mt = res.meta?.regularMarketTime;
  if (rows.length && Number.isFinite(mt) && nyDay(rows[rows.length - 1].t) === nyDay(mt)) rows.pop();
  const last10 = rows.slice(-10).map(r => r.v);
  const av = last10.length ? Math.round(last10.reduce((a, b) => a + b, 0) / last10.length) : null;
  if (av) {
    const resp = new Response(JSON.stringify({ av }), { headers: { "Cache-Control": "max-age=21600" } });
    if (ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, resp)); else await cache.put(cacheKey, resp);
  }
  return av;
}

/* בשעות מסחר מורחבות משתמשים בנרות של דקה — רק שם יאהו מדווח ווליום לנרות טרום/אחרי */
function nyMinutesNow() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const m = Object.fromEntries(p.map(x => [x.type, x.value]));
  return (+m.hour) * 60 + (+m.minute);
}
function extendedHoursNow() {
  const min = nyMinutesNow();
  return (min >= 240 && min < 570) || (min >= 960 && min < 1200);
}

const WORKER_VERSION = 3;

async function quoteOne(sym, budget, ctx, debug) {
  const interval = extendedHoursNow() ? "1m" : "2m";
  const [res, av] = await Promise.all([
    chart(sym, "range=1d&interval=" + interval + "&includePrePost=true"),
    avgVol10d(sym, budget, ctx).catch(() => null)
  ]);
  const meta = res.meta || {};
  const q = res.indicators?.quote?.[0] || {};
  const ts = res.timestamp || [];
  const last = lastFinite(q.close || []);
  const extPrice = last.v;
  const extTime = last.i >= 0 ? ts[last.i] : null;

  const regStart = meta.currentTradingPeriod?.regular?.start ?? null;
  const regEnd = meta.currentTradingPeriod?.regular?.end ?? null;
  const nowSec = Math.floor(Date.now() / 1000);
  let state = "closed";
  if (Number.isFinite(regStart) && Number.isFinite(regEnd)) {
    state = nowSec < regStart ? "pre" : nowSec < regEnd ? "regular" : "post";
  }

  let open = null;
  if (Number.isFinite(regStart)) {
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] >= regStart && Number.isFinite(q.open?.[i]) && q.open[i] > 0) { open = q.open[i]; break; }
    }
  }

  /* ווליום טרום מסחר — סכום הנרות שלפני פתיחת הסשן הרגיל של היום */
  let preVolume = null;
  if (Number.isFinite(regStart)) {
    let sum = 0, seen = false;
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] < regStart && Number.isFinite(q.volume?.[i]) && q.volume[i] > 0) { sum += q.volume[i]; seen = true; }
    }
    if (seen) preVolume = sum;
  }

  const fin = x => (Number.isFinite(x) && x > 0 ? x : null);
  const regular = fin(meta.regularMarketPrice);
  const prev = fin(meta.previousClose) ?? fin(meta.chartPreviousClose);

  let dbg;
  if (debug) {
    const preBars = ts.filter(t => Number.isFinite(regStart) && t < regStart).length;
    let preWithVol = 0;
    for (let i = 0; i < ts.length; i++) if (ts[i] < regStart && Number.isFinite(q.volume?.[i]) && q.volume[i] > 0) preWithVol++;
    dbg = { interval, bars: ts.length, preBars, preBarsWithVol: preWithVol, regStart, nowNYMin: nyMinutesNow(), extendedNow: extendedHoursNow() };
  }

  return {
    v: WORKER_VERSION,
    ...(dbg ? { _debug: dbg } : {}),
    symbol: sym,
    price: regular ?? extPrice,
    regularMarketPrice: regular,
    previousClose: prev,
    preMarketPrice: state === "pre" ? extPrice : null,
    postMarketPrice: state === "post" ? extPrice : null,
    extendedPrice: extPrice,
    time: state === "regular" ? (meta.regularMarketTime ?? extTime) : (extTime ?? meta.regularMarketTime ?? null),
    open,
    dayHigh: fin(meta.regularMarketDayHigh),
    dayLow: fin(meta.regularMarketDayLow),
    volume: Number.isFinite(meta.regularMarketVolume) && meta.regularMarketVolume >= 0 ? meta.regularMarketVolume : null,
    preVolume,
    avgVol10d: av,
    marketState: state
  };
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const multi = u.searchParams.get("symbols");
    const single = u.searchParams.get("symbol");
    try {
      if (multi) {
        const syms = [...new Set(multi.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))].slice(0, 32);
        if (!syms.length) return new Response(JSON.stringify({ error: "empty symbols" }), { status: 400, headers: CORS });
        const budget = { left: 15 };
        const settled = await Promise.allSettled(syms.map(s => quoteOne(s, budget, ctx)));
        const quotes = {}, errors = {};
        settled.forEach((r, i) => {
          if (r.status === "fulfilled") quotes[syms[i]] = r.value;
          else errors[syms[i]] = String(r.reason?.message || r.reason);
        });
        return new Response(JSON.stringify({ v: WORKER_VERSION, quotes, errors, time: Math.floor(Date.now() / 1000) }), { headers: CORS });
      }
      if (single) {
        const d = await quoteOne(single.trim().toUpperCase(), { left: 2 }, ctx, u.searchParams.get("debug") === "1");
        return new Response(JSON.stringify(d), { headers: CORS });
      }
      return new Response(JSON.stringify({ error: "missing symbol/symbols param" }), { status: 400, headers: CORS });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 502, headers: CORS });
    }
  }
};
