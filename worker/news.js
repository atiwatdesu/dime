// Cloudflare Worker: รวมข่าวล่าสุดของหุ้นหนึ่งตัวจากหลายแหล่ง ณ ตอนที่ขอ
// GET /?symbol=NVDA → { symbol, fetchedAt, items:[{title,url,publisher,source,time}], sources:{name:'ok'|'error'} }
// secret: FINNHUB_KEY (ตั้งผ่าน wrangler / GitHub Actions) · cache 5 นาทีต่อหุ้น

const ALLOWED_ORIGINS = ['https://atiwatdesu.github.io'];
const CACHE_SECONDS = 300;
const UA = 'Mozilla/5.0 (compatible; dime-portfolio-news/1.0)';

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET') return json({ error: 'method' }, 405, cors);

    const sym = (new URL(req.url).searchParams.get('symbol') || '').toUpperCase().trim();
    if (!/^[A-Z][A-Z.\-]{0,9}$/.test(sym)) return json({ error: 'bad symbol' }, 400, cors);

    const cache = caches.default;
    const key = new Request(`https://news-cache.internal/v1/${sym}`);
    const hit = await cache.match(key);
    if (hit) { const body = await hit.text(); return new Response(body, { headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'HIT' } }); }

    const jobs = {
      'Finnhub': () => finnhub(sym, env.FINNHUB_KEY),
      'Google News': () => googleNews(`${sym} stock`, 'en-US', 'US', 'US:en'),
      'Google News (ไทย)': () => googleNews(`${sym} หุ้น`, 'th', 'TH', 'TH:th'),
      'Yahoo Finance': () => yahooRss(sym),
      'Reddit': () => reddit(sym),
    };
    const names = Object.keys(jobs);
    const settled = await Promise.allSettled(names.map(n => withTimeout(jobs[n](), 6000)));
    const sources = {}, all = [];
    settled.forEach((r, i) => {
      const n = names[i];
      if (r.status === 'fulfilled') { sources[n] = 'ok'; r.value.forEach(it => all.push({ ...it, source: n })); }
      else sources[n] = 'error';
    });

    // ตัดข่าวซ้ำ (หัวข้อเดียวกันจากหลายแหล่ง) แล้วเรียงใหม่สุดก่อน
    const seen = new Set(), items = [];
    for (const it of all.filter(x => x.title && /^https:\/\//.test(x.url)).sort((a, b) => (b.time || 0) - (a.time || 0))) {
      const k = it.title.toLowerCase().replace(/[^a-z0-9฀-๿]+/g, '').slice(0, 60);
      if (seen.has(k)) continue;
      seen.add(k); items.push(it);
      if (items.length >= 30) break;
    }
    const aiStatus = await enrich(items, sym, env, ctx);
    const body = JSON.stringify({ symbol: sym, fetchedAt: Date.now(), items, sources, ai: aiStatus, summary: summarize(items) });
    ctx.waitUntil(cache.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` } })));
    return new Response(body, { headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'MISS' } });
  },
};

const json = (o, status, headers) => new Response(JSON.stringify(o), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

async function finnhub(sym, key) {
  if (!key) throw new Error('no key');
  const to = new Date(), from = new Date(Date.now() - 7 * 864e5);
  const d = x => x.toISOString().slice(0, 10);
  const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${d(from)}&to=${d(to)}&token=${key}`);
  if (!r.ok) throw new Error('http ' + r.status);
  const list = await r.json();
  return (Array.isArray(list) ? list : []).slice(0, 20).map(n => ({ title: n.headline, url: n.url, publisher: n.source || '', time: (n.datetime || 0) * 1000 }));
}

async function googleNews(q, hl, gl, ceid) {
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=${hl}&gl=${gl}&ceid=${ceid}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('http ' + r.status);
  return parseRss(await r.text()).slice(0, 15).map(it => {
    // หัวข้อจาก Google News ลงท้ายด้วย " - สำนักข่าว"
    const pub = it.source || '';
    const title = pub && it.title.endsWith(' - ' + pub) ? it.title.slice(0, -(pub.length + 3)) : it.title;
    return { title, url: it.link, publisher: pub, time: it.time };
  });
}

async function yahooRss(sym) {
  const r = await fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('http ' + r.status);
  return parseRss(await r.text()).slice(0, 15).map(it => ({ title: it.title, url: it.link, publisher: 'Yahoo Finance', time: it.time }));
}

async function reddit(sym) {
  const r = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(`"${sym}" OR "$${sym}"`)}&sort=new&t=week&limit=15`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json();
  const re = new RegExp(`(^|[^A-Za-z])\\$?${sym.replace('.', '\\.')}([^A-Za-z]|$)`);
  return (j?.data?.children || []).map(c => c.data).filter(p => re.test(p.title))
    .map(p => ({ title: p.title, url: 'https://www.reddit.com' + p.permalink, publisher: 'r/' + p.subreddit, time: (p.created_utc || 0) * 1000 }));
}

export function parseRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const block = m[0];
    const tag = t => { const x = block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`)); return x ? decode(x[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()) : ''; };
    const time = Date.parse(tag('pubDate')) || 0;
    out.push({ title: tag('title'), link: tag('link'), source: tag('source'), time });
  }
  return out;
}

function decode(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// ---------- ระดับความสำคัญ / แนวโน้ม ----------
// imp: 1–5 (4–5 = สูง, 3 = กลาง, 1–2 = ทั่วไป) · dir: pos | neg | neu · th: หัวข้อภาษาไทย · by: ai | kw
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const HIGH = /earnings|results|revenue|guidance|outlook|forecast|offering|dilut|reverse split|stock split|split|fda|approv|merger|acqui|buyout|takeover|lawsuit|sue[sd]?\b|probe|investigation|sec\b|delist|bankrupt|chapter 11|default|recall|งบ|ผลประกอบการ|เพิ่มทุน|ควบรวม|ซื้อกิจการ|ฟ้อง|ล้มละลาย|ถอดถอน/i;
const MID = /upgrade|downgrade|price target|target price|rating|initiat|contract|deal|partnership|order|award|insider|ceo|cfo|resign|appoint|buyback|dividend|layoff|guid|ราคาเป้าหมาย|ปรับเพิ่ม|ปรับลด|สัญญา|ปันผล|ผู้บริหาร/i;
const POS = /beat|beats|surge|soar|jump|rall(y|ies)|gain|rise|rises|record|upgrade|raise[sd]?|strong|approv|win|wins|award|outperform|bullish|breakthrough|profit|พุ่ง|ขึ้น|กำไร|บวก|ทะยาน|นิวไฮ/i;
const NEG = /miss|misses|plunge|tumble|fall|falls|drop|slump|sink|downgrade|cut[s]?\b|weak|lawsuit|probe|offering|dilut|delist|bankrupt|loss|losses|warn|bearish|recall|halt|ร่วง|ลง|ขาดทุน|ลบ|ดิ่ง|ฟ้อง/i;

function keywordTag(title) {
  const imp = HIGH.test(title) ? 4 : MID.test(title) ? 3 : 2;
  const p = POS.test(title), n = NEG.test(title);
  return { imp, dir: p && !n ? 'pos' : n && !p ? 'neg' : 'neu' };
}

const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const isThai = s => /[฀-๿]/.test(s);

async function enrich(items, sym, env, ctx) {
  // ผล AI ของแต่ละหัวข้อเก็บไว้ 7 วัน: หัวข้อเดิมไม่ถูกส่งให้ AI ซ้ำ (ประหยัดโควตา)
  const cache = caches.default, keyOf = it => new Request(`https://news-cache.internal/ai/v1/${sym}/${hash(it.title)}`);
  const todo = [];
  await Promise.all(items.map(async it => {
    const kw = keywordTag(it.title);
    Object.assign(it, kw, { th: isThai(it.title) ? it.title : '', by: 'kw' });
    const hit = await cache.match(keyOf(it));
    if (hit) { try { Object.assign(it, await hit.json(), { by: 'ai' }); } catch {} } else todo.push(it);
  }));
  if (!todo.length) return 'ok';
  if (!env.AI) return 'off';
  try {
    const list = todo.map((it, i) => `${i}. ${it.title}`).join('\n');
    const res = await withTimeout(env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: `You rate news headlines for a retail investor holding the US stock ${sym}. For each numbered headline return: imp = importance to ${sym} shareholders 1-5 (5 = earnings, guidance, offering/dilution, splits, M&A, FDA, lawsuits, delisting; 3 = analyst rating/price target, contracts, insider trades; 1 = generic market chatter or barely about ${sym}); dir = expected effect on ${sym} for shareholders: "pos", "neg" or "neu"; th = natural Thai translation of the headline (keep tickers and company names in English). Reply with ONLY a JSON array like [{"i":0,"imp":4,"dir":"pos","th":"..."}].` },
        { role: 'user', content: list },
      ],
      max_tokens: 2500,
      temperature: 0.1,
    }), 20000);
    const text = typeof res?.response === 'string' ? res.response : JSON.stringify(res?.response ?? '');
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    let n = 0;
    for (const r of Array.isArray(arr) ? arr : []) {
      const it = todo[+r.i]; if (!it) continue;
      const imp = Math.min(5, Math.max(1, Math.round(+r.imp || 0))), dir = ['pos', 'neg', 'neu'].includes(r.dir) ? r.dir : null;
      if (!imp || !dir) continue;
      const tag = { imp, dir, th: String(r.th || it.th || '').slice(0, 300) };
      Object.assign(it, tag, { by: 'ai' }); n++;
      ctx.waitUntil(cache.put(keyOf(it), new Response(JSON.stringify(tag), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=604800' } })));
    }
    return n ? 'ok' : 'fallback';
  } catch (e) {
    return /4006|quota|neurons|limit|429/i.test(String(e?.message || e)) ? 'quota' : 'fallback';
  }
}

function summarize(items) {
  const c = { pos: 0, neg: 0, neu: 0 }; let w = 0, sc = 0;
  for (const it of items) { c[it.dir] = (c[it.dir] || 0) + 1; w += it.imp; sc += (it.dir === 'pos' ? 1 : it.dir === 'neg' ? -1 : 0) * it.imp; }
  const r = w ? sc / w : 0;
  return { ...c, score: +r.toFixed(2), label: r > 0.35 ? 'บวก' : r > 0.12 ? 'ค่อนข้างบวก' : r < -0.35 ? 'ลบ' : r < -0.12 ? 'ค่อนข้างลบ' : 'กลาง/ผสม' };
}
