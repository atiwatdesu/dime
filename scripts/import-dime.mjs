// ดึงใบยืนยันการซื้อขาย (Confirmation Note) ของ Dime จาก Gmail → ตัดข้อมูลส่วนตัว → แยกรายการ → บันทึกลง Firestore
// repo เป็น public: log และ summary ต้องไม่มีชื่อหุ้น จำนวน ราคา ชื่อไฟล์ หรือข้อมูลส่วนตัว มีแค่ตัวเลขสรุปและวันที่อีเมล
//
// env: GMAIL_USER, GMAIL_APP_PASSWORD, DIME_PDF_PASSWORD, FIREBASE_SERVICE_ACCOUNT, APP_USER_EMAIL
//      SINCE=YYYY-MM-DD (default 2025-01-01), DRY_RUN=true|false (default true)
//      LOCAL_PDF_DIR=โฟลเดอร์ PDF สำหรับทดสอบ (ข้าม Gmail)
import fs from 'node:fs';
import path from 'node:path';
import pdfjs from 'pdfjs-dist/legacy/build/pdf.js';
import { linesFromPages, parseDime, parseOcc } from '../site/dime-parser.js';

const env = process.env;
const DRY = (env.DRY_RUN ?? 'true') !== 'false';
const SINCE = /^\d{4}-\d{2}-\d{2}$/.test(env.SINCE || '') ? env.SINCE : '2025-01-01';
const summary = [];
const say = s => { console.log(s); summary.push(s); };
const done = code => { if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n'); process.exit(code); };

if (!env.DIME_PDF_PASSWORD) { say('❌ ไม่มี secret DIME_PDF_PASSWORD'); done(1); }

// ---------- 1) รวบรวม PDF ----------
const docs = []; // {when: 'YYYY-MM-DD', buf}
if (env.LOCAL_PDF_DIR) {
  for (const f of fs.readdirSync(env.LOCAL_PDF_DIR).filter(f => /\.pdf$/i.test(f)).sort())
    docs.push({ when: 'local', buf: fs.readFileSync(path.join(env.LOCAL_PDF_DIR, f)) });
} else {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) { say('❌ ไม่มี secret GMAIL_USER หรือ GMAIL_APP_PASSWORD'); done(1); }
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD }, logger: false });
  try { await client.connect(); } catch (e) { say('❌ เข้า Gmail ไม่ได้ ตรวจ GMAIL_USER / App Password และว่าเปิด IMAP แล้ว'); done(1); }
  const boxes = await client.list();
  const all = boxes.find(b => b.specialUse === '\\All')?.path || 'INBOX';
  const lock = await client.getMailboxLock(all);
  try {
    const q = `from:dime subject:"Confirmation Note" has:attachment filename:pdf after:${SINCE.replace(/-/g, '/')}`;
    const uids = (await client.search({ gmraw: q }, { uid: true })) || [];
    say(`📬 พบอีเมล Confirmation Note ${uids.length} ฉบับ (ตั้งแต่ ${SINCE})`);
    for (const uid of uids) {
      const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
      const when = msg?.envelope?.date ? new Date(msg.envelope.date).toISOString().slice(0, 10) : '?';
      const parts = [];
      const walk = n => { if (!n) return; const fn = n.dispositionParameters?.filename || n.parameters?.name || '';
        if (/\.pdf$/i.test(fn) && /offshore|confirm/i.test(fn)) parts.push(n.part); (n.childNodes || []).forEach(walk); };
      walk(msg.bodyStructure);
      if (!parts.length) { say(`- ⚠️ อีเมลวันที่ ${when}: ไม่พบไฟล์แนบ Confirmation Note`); continue; }
      for (const part of parts) {
        const { content } = await client.download(uid, part, { uid: true });
        const chunks = []; for await (const c of content) chunks.push(c);
        docs.push({ when, buf: Buffer.concat(chunks) });
      }
    }
  } finally { lock.release(); await client.logout(); }
}

// ---------- 2) อ่าน PDF (ตัดข้อมูลส่วนตัวก่อนอ่าน) ----------
const trades = new Map(); const failed = [];
let pdfOk = 0, redacted = 0, rawRescue = 0, shown = { ok: 0, bad: 0, fx: 0 };
// DEBUG_SHAPE: พิมพ์เฉพาะ "รูปร่าง" ของบรรทัด (ตัวเลข→N วันที่→D คำ→W ภาษาไทย→ท) ไม่มีชื่อหุ้น ตัวเลข หรือข้อมูลส่วนตัว
const KEY = /^(BUY|SELL|REW|EXC|EXP|DIV|USD|THB|Order|History|Effective|Date|Confirmation|Note|Unit|Price|Gross|Amount|Fee|Total|ID|Settlement|Type|Transaction|Securities|Currency|Withholding|Tax|Include|Vat|CCY)$/i;
const shape = l => l.split(' ').map(t => KEY.test(t) ? t : /^\[[A-Z]+\]$/.test(t) ? '[EX]' : /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t) ? 'D' : /^[\d,]*\.?\d+$/.test(t) ? 'N' : /[\u0E00-\u0E7F]/.test(t) ? 'ท' : /\d/.test(t) ? t.replace(/[A-Za-z]/g, 'A').replace(/\d/g, '9') : 'W').join(' ').replace(/(ท )+ท/g, 'ท…');
const DEBUG = env.DEBUG_SHAPE === 'true';
const typeCodes = new Map(); // รหัสประเภทรายการที่เจอหลังวันที่ (เช่น BUY/SELL) — ไม่ใช่ข้อมูลส่วนตัว
for (const d of docs) {
  try {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(d.buf), password: env.DIME_PDF_PASSWORD, isEvalSupported: false, verbosity: 0 }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) { const pg = await pdf.getPage(i); pages.push({ items: (await pg.getTextContent()).items, vp: pg.getViewport({ scale: 1 }) }); }
    const lines = linesFromPages(pages); redacted += lines.dropped || 0;
    const rows = parseDime(lines);
    if (DEBUG && !rows.some(r => r.thb != null) && shown.fx < 2) { shown.fx++; console.log(`\n== ไม่พบเรต ${d.when}: บรรทัดที่มีคำว่า rate/THB/USD/อัตรา ==`); lines.filter(l => /rate|THB|USD|อัตรา|แลกเปลี่ยน/i.test(l)).forEach(l => console.log('  ' + shape(l))); }
    for (const m of lines.join(' ').matchAll(/\b\d{4,}\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+([A-Za-z]{2,8})\b/g)) if (!/^(BUY|SELL?|REW|EXC|EXP)$/.test(m[2])) failed.push(`${d.when}: มีรายการประเภท ${m[2]} (วันที่ ${m[1]}) ยังไม่ได้บันทึก ต้องตรวจเอง`);
    if (DEBUG) for (const m of lines.join(' ').matchAll(/\b\d{4,}\s+\d{1,2}\/\d{1,2}\/\d{4}\s+([A-Za-z]{2,8})\b/g)) typeCodes.set(m[1] + (rows.length ? '' : ' (ไฟล์ที่อ่านไม่ได้)'), (typeCodes.get(m[1] + (rows.length ? '' : ' (ไฟล์ที่อ่านไม่ได้)')) || 0) + 1);
    if (DEBUG && (rows.length ? shown.ok < 1 : shown.bad < 3)) {
      rows.length ? shown.ok++ : shown.bad++;
      const raw = []; for (const p of pages) { let y = null, line = []; for (const it of p.items) { const s = (it.str || '').trim(), yy = Math.round(it.transform[5]); if (y !== null && Math.abs(yy - y) > 2) { raw.push(line.join(' ')); line = []; } y = yy; if (s) line.push(s); } raw.push(line.join(' ')); }
      const rawRows = parseDime(raw.filter(Boolean)).length;
      console.log(`\n===== ${rows.length ? 'OK' : 'FAIL'} ${d.when} · หน้า ${pages.length} · items ${pages.reduce((a, p) => a + p.items.length, 0)} · ตัดทิ้ง ${lines.dropped} · แถวที่อ่านได้ถ้าไม่ตัด = ${rawRows} =====`);
      lines.forEach(l => console.log('  ' + shape(l)));
    }
    (rows.other || []).forEach(o => failed.push(`${d.when}: มีรายการ ${o.code} ที่ไม่ใช่ออปชัน (วันที่ ${o.date}) ยังไม่ได้บันทึก ต้องตรวจเอง`));
    if (!rows.length && rows.other?.length) continue;
    if (!rows.length) { failed.push(`${d.when}: อ่านตารางรายการไม่ได้ (รูปแบบ PDF อาจต่างจากที่รู้จัก)`); continue; }
    rows.forEach(r => trades.set(r.ref, r)); pdfOk++;
  } catch (e) {
    failed.push(`${d.when}: ${e?.name === 'PasswordException' ? 'รหัส PDF ไม่ถูกต้อง' : 'เปิดไฟล์ไม่ได้'}`);
  }
}
const withThb = [...trades.values()].filter(t => t.thb != null).length;
say(`💱 มียอดบาทตามใบยืนยัน ${withThb}/${trades.size} รายการ`);
say(`📄 อ่านสำเร็จ ${pdfOk}/${docs.length} ไฟล์ · พบ ${trades.size} รายการ · ตัดข้อมูลส่วนตัวทิ้ง ${redacted} จุด`);

// ---------- 3) บันทึกลง Firestore ----------
const splits = JSON.parse(fs.readFileSync(new URL('./splits.json', import.meta.url)));
let written = 0, skipped = 0, maybeDup = 0, splitAdd = 0;
if (!env.FIREBASE_SERVICE_ACCOUNT) {
  say(DRY ? 'ℹ️ ไม่มี FIREBASE_SERVICE_ACCOUNT ข้ามการเทียบกับข้อมูลเดิม' : '❌ ไม่มี FIREBASE_SERVICE_ACCOUNT');
  if (!DRY) done(1);
} else {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');
  initializeApp({ credential: cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();
  let uid;
  try { uid = (await getAuth().getUserByEmail(env.APP_USER_EMAIL)).uid; } catch { say('❌ ไม่พบบัญชีผู้ใช้ใน Firebase Authentication'); done(1); }
  const col = db.collection(`users/${uid}/txns`);
  const existing = (await col.get()).docs.map(d => d.data());
  const refs = new Set(existing.map(x => x.ref).filter(Boolean));
  const fp = x => `${x.sym}|${x.type}|${x.date}|${(+x.qty).toFixed(4)}`;
  const manual = new Set(existing.filter(x => !x.ref && x.type !== 'split').map(fp));
  const toWrite = [];
  for (const t of trades.values()) {
    if (refs.has(t.ref)) { skipped++; continue; }
    if (manual.has(fp(t))) { maybeDup++; continue; }
    toWrite.push({ sym: t.sym, type: t.type, date: t.date, qty: t.qty, price: t.price, fee: t.fee, cur: 'USD', ref: t.ref, t: /-OPT$/.test(t.ref) ? 9e15 : (Number(t.ref.replace(/\D/g, '')) || 1), src: 'gmail', ...(t.note ? { note: t.note } : {}), ...(t.thb != null ? { thb: t.thb } : {}) });
  }
  // ออปชันที่เลยวันหมดอายุแล้วแต่ยังค้าง (ไม่มีรายการใช้สิทธิ/หมดอายุ) → ปิดที่ 0 ในวันหมดอายุ
  const today = new Date().toISOString().slice(0, 10);
  const optNet = {};
  for (const x of [...existing, ...toWrite]) { if (!parseOcc(x.sym) || x.type === 'split') continue; optNet[x.sym] = (optNet[x.sym] || 0) + (x.type === 'sell' ? -x.qty : x.qty); }
  let expired = 0;
  for (const [sym, q] of Object.entries(optNet)) {
    const o = parseOcc(sym), ref = `EXPIRE-${sym}`;
    if (q > 1e-9 && o.exp < today && !refs.has(ref)) { toWrite.push({ sym, type: 'sell', date: o.exp, qty: q, price: 0, fee: 0, cur: 'USD', ref, t: 9e15, src: 'auto-expire', note: 'ออปชันหมดอายุ' }); expired++; }
  }
  const syms = new Set([...existing, ...toWrite].filter(x => x.type !== 'split').map(x => x.sym));
  for (const s of splits) {
    const ref = `SPLIT-${s.sym}-${s.date}`;
    if (!syms.has(s.sym) || refs.has(ref)) continue;
    const before = [...existing, ...toWrite].some(x => x.sym === s.sym && x.type !== 'split' && x.date < s.date);
    if (!before) continue;
    toWrite.push({ sym: s.sym, type: 'split', date: s.date, from: s.from, to: s.to, ratio: s.to / s.from, qty: 0, price: 0, fee: 0, t: 0, ref, src: 'splits.json' }); splitAdd++;
  }
  if (!DRY) {
    for (let i = 0; i < toWrite.length; i += 400) {
      const b = db.batch();
      for (const x of toWrite.slice(i, i + 400)) b.set(col.doc(x.ref), { ...x, id: x.ref });
      await b.commit();
    }
  }
  written = toWrite.length;
  say(`${DRY ? '🧪 ทดลองรัน (ยังไม่บันทึก)' : '💾 บันทึกแล้ว'}: รายการใหม่ ${written - splitAdd - expired} · แตกพาร์ ${splitAdd} · ปิดออปชันที่หมดอายุ ${expired} · มีอยู่แล้ว ${skipped} · ข้ามเพราะอาจซ้ำกับที่กรอกเอง ${maybeDup}`);
}
if (DEBUG) say(`🔤 รหัสประเภทรายการที่เจอ: ${[...typeCodes].map(([k, v]) => `${k}×${v}`).join(', ')}`);
if (failed.length) { say(`\n⚠️ อ่านไม่ได้ ${failed.length} ไฟล์:`); failed.forEach(f => say(`- ${f}`)); }
done(0);
