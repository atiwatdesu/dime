// ตรวจข้อมูลแบบไม่เปิดเผยยอดเงิน (repo เป็น public): พิมพ์เฉพาะจำนวนรายการและอัตราส่วน
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();
const uid = (await getAuth().getUserByEmail(process.env.APP_USER_EMAIL)).uid;
const tx = (await db.collection(`users/${uid}/txns`).get()).docs.map(d => d.data());
const prices = new Set((await db.collection('prices').get()).docs.map(d => d.id));
const isOpt = s => /\d{6}[CP]\d{8}$/.test(s);

const by = {}; let bU = 0, sU = 0, bT = 0, sT = 0, noThb = 0, strThb = 0, negThb = 0;
for (const x of tx) {
  (by[x.type] = (by[x.type] || 0) + 1);
  if (x.type === 'split') continue;
  const amt = x.type === 'buy' ? x.qty * x.price + (+x.fee || 0) : x.qty * x.price - (+x.fee || 0);
  if (typeof x.thb === 'string') strThb++;
  if (x.thb == null) { noThb++; continue; }
  if (x.thb < 0) negThb++;
  if (x.type === 'buy') { bU += amt; bT += +x.thb; } else { sU += amt; sT += +x.thb; }
}
console.log('รายการตามประเภท:', JSON.stringify(by));
console.log(`ไม่มี thb ${noThb} · thb เป็นข้อความ ${strThb} · thb ติดลบ ${negThb}`);
console.log(`เรตเฉลี่ยที่ฝังใน thb: ซื้อ ${(bT / bU).toFixed(3)} · ขาย ${(sT / sU).toFixed(3)} บาท/USD`);
console.log(`สัดส่วน ขาย/ซื้อ: USD ${(sU / bU).toFixed(4)} · THB ${(sT / bT).toFixed(4)}`);

// หุ้นที่ยังถือ (FIFO แบบง่าย: นับจำนวนสุทธิ พร้อมแตกพาร์)
const g = {};
for (const x of [...tx].sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.t || 0) - (b.t || 0))) {
  if (x.type === 'split') { if (g[x.sym]) g[x.sym] *= x.ratio; continue; }
  g[x.sym] = (g[x.sym] || 0) + (x.type === 'sell' ? -x.qty : x.qty);
}
const held = Object.entries(g).filter(([, q]) => q > 1e-6).map(([s]) => s);
const neg = Object.entries(g).filter(([, q]) => q < -1e-6).length;
const unpriced = held.filter(s => !prices.has(s));
console.log(`ยังถือ ${held.length} ตัว · ไม่มีราคา ${unpriced.length} ตัว (เป็นออปชัน ${unpriced.filter(isOpt).length}) · ขายเกินจำนวน ${neg} ตัว`);
console.log('ตัวที่ไม่มีราคา (ความยาวชื่อ/ชนิด):', unpriced.map(s => isOpt(s) ? 'OPT' : `${s.length}ตัวอักษร${/[^A-Z]/.test(s) ? '+สัญลักษณ์' : ''}`).join(', '));
