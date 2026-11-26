// ดึงใบยืนยันการซื้อขาย (Confirmation Note) ของ Dime จาก Gmail → ตัดข้อมูลส่วนตัว → แยกรายการ → บันทึกลง Firestore
// repo เป็น public: log และ summary ต้องไม่มีชื่อหุ้น จำนวน ราคา ชื่อไฟล์ หรือข้อมูลส่วนตัว มีแค่ตัวเลขสรุปและวันที่อีเมล
//
// env: GMAIL_USER, GMAIL_APP_PASSWORD, DIME_PDF_PASSWORD, FIREBASE_SERVICE_ACCOUNT, APP_USER_EMAIL
//      SINCE=YYYY-MM-DD (default 2025-01-01), DRY_RUN=true|false (default true)
//      LOCAL_PDF_DIR=โฟลเดอร์ PDF สำหรับทดสอบ (ข้าม Gmail)
import fs from 'node:fs';
import path from 'node:path';
import pdfjs from 'pdfjs-dist/legacy/build/pdf.js';
import { linesFromPages, parseDime } from '../site/dime-parser.js';

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
let pdfOk = 0, redacted = 0;
for (const d of docs) {
  try {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(d.buf), password: env.DIME_PDF_PASSWORD, isEvalSupported: false, verbosity: 0 }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) { const pg = await pdf.getPage(i); pages.push({ items: (await pg.getTextContent()).items, vp: pg.getViewport({ scale: 1 }) }); }
    const lines = linesFromPages(pages); redacted += lines.dropped || 0;
    const rows = parseDime(lines);
    if (!rows.length) { failed.push(`${d.when}: อ่านตารางรายการไม่ได้ (รูปแบบ PDF อาจต่างจากที่รู้จัก)`); continue; }
    rows.forEach(r => trades.set(r.ref, r)); pdfOk++;
  } catch (e) {
    failed.push(`${d.when}: ${e?.name === 'PasswordException' ? 'รหัส PDF ไม่ถูกต้อง' : 'เปิดไฟล์ไม่ได้'}`);
  }
}
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
    toWrite.push({ sym: t.sym, type: t.type, date: t.date, qty: t.qty, price: t.price, fee: t.fee, cur: 'USD', ref: t.ref, t: Number(t.ref.replace(/\D/g, '')) || 1, src: 'gmail' });
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
  say(`${DRY ? '🧪 ทดลองรัน (ยังไม่บันทึก)' : '💾 บันทึกแล้ว'}: รายการใหม่ ${written - splitAdd} · แตกพาร์ ${splitAdd} · มีอยู่แล้ว ${skipped} · ข้ามเพราะอาจซ้ำกับที่กรอกเอง ${maybeDup}`);
}
if (failed.length) { say(`\n⚠️ อ่านไม่ได้ ${failed.length} ไฟล์:`); failed.forEach(f => say(`- ${f}`)); }
done(0);
