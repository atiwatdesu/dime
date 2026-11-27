// อัปเดตราคาหุ้นที่มีคนถืออยู่ + เรต USD/THB ลง Firestore
// ต้องมี env: FIREBASE_SERVICE_ACCOUNT (JSON ทั้งก้อน), FINNHUB_KEY
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
const key = process.env.FINNHUB_KEY;
if (!sa.project_id || !key) { console.error('Missing FIREBASE_SERVICE_ACCOUNT or FINNHUB_KEY'); process.exit(1); }

initializeApp({ credential: cert(sa) });
const db = getFirestore();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = new Date().toISOString();

// 1) รวมหุ้นที่ยังถืออยู่ (ซื้อ − ขาย > 0) จากทุกผู้ใช้
const snap = await db.collectionGroup('txns').get();
const byKey = {};
snap.forEach(d => {
  const x = d.data(), owner = d.ref.parent.parent?.id || '';
  if (!x.sym) return;
  (byKey[owner + '|' + x.sym] ||= []).push(x);
});
const net = {};
for (const [k, list] of Object.entries(byKey)) {
  list.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.t || 0) - (b.t || 0));
  let q = 0;
  for (const x of list) {
    if (x.type === 'split') { if (x.ratio > 0) q *= x.ratio; }
    else if (x.qty > 0) q += x.type === 'sell' ? -x.qty : x.qty;
  }
  net[k] = q;
}
const isOption = s => /\d{6}[CP]\d{8}$/.test(s); // ออปชัน: Finnhub ไม่มีราคา ข้าม
const syms = [...new Set(Object.entries(net).filter(([, q]) => q > 1e-6).map(([k]) => k.split('|')[1]).filter(s => !isOption(s)))].sort();
console.log(`Holdings: ${syms.length} symbol(s)`); // repo เป็น public: ไม่พิมพ์ชื่อหุ้นหรือราคาใน log

// 2) ราคาจาก Finnhub (free tier 60 ครั้ง/นาที → เว้น 1.1 วินาทีต่อครั้ง)
const failed = [];
for (const sym of syms) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const q = await r.json();
    const v = q.c > 0 ? q.c : q.pc;
    if (!(v > 0)) throw new Error('no price');
    await db.doc(`prices/${sym}`).set({ v, pc: q.pc ?? null, quoteTime: q.t ? new Date(q.t * 1000).toISOString() : null, at: now, src: 'auto' });
  } catch (e) { failed.push(sym); console.warn('FAILED one symbol:', e.message); }
  await sleep(1100);
}

// 3) เรต USD/THB จาก Frankfurter (ไม่ต้องใช้ key)
try {
  const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=THB');
  const j = await r.json();
  const v = j?.rates?.THB;
  if (!(v > 0)) throw new Error('no rate');
  await db.doc('fx/USDTHB').set({ v, rateDate: j.date || null, at: now, src: 'auto' });
  console.log('USDTHB updated');
} catch (e) { failed.push('USDTHB'); console.warn('FAILED USDTHB', e.message); }

if (failed.length) { console.error(`Could not update ${failed.length} item(s)`); process.exitCode = failed.length > syms.length / 2 ? 1 : 0; }
