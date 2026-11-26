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
const net = {};
snap.forEach(d => {
  const x = d.data(), owner = d.ref.parent.parent?.id || '';
  if (!x.sym || !(x.qty > 0)) return;
  const k = owner + '|' + x.sym;
  net[k] = (net[k] || 0) + (x.type === 'sell' ? -x.qty : x.qty);
});
const syms = [...new Set(Object.entries(net).filter(([, q]) => q > 1e-6).map(([k]) => k.split('|')[1]))].sort();
console.log('Holdings:', syms.join(', ') || '(none)');

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
    console.log(sym, v);
  } catch (e) { failed.push(sym); console.warn('FAILED', sym, e.message); }
  await sleep(1100);
}

// 3) เรต USD/THB จาก Frankfurter (ไม่ต้องใช้ key)
try {
  const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=THB');
  const j = await r.json();
  const v = j?.rates?.THB;
  if (!(v > 0)) throw new Error('no rate');
  await db.doc('fx/USDTHB').set({ v, rateDate: j.date || null, at: now, src: 'auto' });
  console.log('USDTHB', v);
} catch (e) { failed.push('USDTHB'); console.warn('FAILED USDTHB', e.message); }

if (failed.length) { console.error('Could not update:', failed.join(', ')); process.exitCode = failed.length > syms.length / 2 ? 1 : 0; }
