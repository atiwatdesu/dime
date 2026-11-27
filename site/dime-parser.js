/* Shared by the web app and scripts/import-dime.mjs (GitHub Actions). Keep it dependency-free. */
export function ymd(y,mo,d){if(y<100)y+=2000;if(y>2400)y-=543;if(mo<1||mo>12||d<1||d>31)return'';return`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`}
/* Privacy: before any text is read, drop the statement's header zone (customer name, address,
   tax ID, account no., invoice no., issue date, company registration) and any repeat of those
   IDs/names elsewhere (page footer, payment details). Only what remains is parsed or shown. */
export function headerZoneDrop(items,vp){
  const its=items.map((it,k)=>{const t=it.transform,[x,y]=vp.convertToViewportPoint(t[4],t[5]),h=Math.hypot(t[2],t[3])||it.height||8;return{k,str:(it.str||'').trim(),x,y,h}}).filter(i=>i.str);
  const title=its.filter(i=>/Confirmation Note|ใบยืนยันการซื้อขาย/i.test(i.str));
  const oh=its.filter(i=>/Order History|รายการคำสั่ง/i.test(i.str)).sort((a,b)=>a.y-b.y)[0];
  if(!title.length)return new Set();
  const top=Math.min(...title.map(i=>i.y-i.h))-14;
  const keep=new Set(title),effRow=[];
  for(const E of its.filter(i=>/Effective\s*Date|วันที่คำสั่งมีผล/i.test(i.str))){keep.add(E);effRow.push(E);
    const d=its.filter(i=>/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(i.str)&&i.x>E.x&&Math.abs(i.y-E.y)<16).sort((a,b)=>a.x-b.x)[0];if(d){keep.add(d);effRow.push(d)}}
  // ขอบล่างของโซน: แถว "วันที่คำสั่งมีผล / วันที่ออกใบกำกับ" คือแถวสุดท้ายของหัวเอกสาร (ตารางรายการอยู่ใต้แถวนี้เสมอ)
  // ถ้าหาไม่เจอ ใช้ป้าย Order History หรือหัวตาราง และสุดท้ายใช้แถวแรกของตาราง ห้ามตัดลึกกว่าแถวแรก
  const tableTop=its.filter(i=>/^(BUY|SELL|REW|EXC|EXP)$/.test(i.str)||/Order\s*ID|Settlement|Securities/i.test(i.str)).reduce((m,i)=>Math.min(m,i.y-i.h*3),Infinity);
  let bottom=effRow.length?Math.max(...effRow.map(i=>i.y))+4:oh?oh.y-oh.h-2:vp.height*.45;
  bottom=Math.min(bottom,tableTop);
  return new Set(its.filter(i=>i.y>=top&&i.y-i.h<=bottom&&!keep.has(i)).map(i=>i.k));
}
export function linesFromPages(pages){
  // pages: [{items, vp}] — items from page.getTextContent(), vp = page.getViewport({scale:1})
  for(const p of pages)p.drop=headerZoneDrop(p.items,p.vp);
  const secret=new Set();
  for(const p of pages)for(const k of p.drop){const s=(p.items[k].str||'').trim();if(/\d{6,}/.test(s)||/^(นาย|นางสาว|นาง|Mr|Mrs|Ms|Miss)[\s.]/i.test(s))secret.add(s)}
  const hidden=s=>[...secret].some(x=>s.includes(x)||(x.match(/\d{6,}/g)||[]).some(n=>s.includes(n)));
  const all=[];let dropped=0;
  for(const p of pages){let y=null,line=[];
    p.items.forEach((it,k)=>{const s=(it.str||'').trim();const yy=Math.round(it.transform[5]);if(y!==null&&Math.abs(yy-y)>2){all.push(line.join(' '));line=[]}y=yy;
      if(!s)return;if(p.drop.has(k)||hidden(s)){dropped++;return}line.push(s)});all.push(line.join(' '))}
  const lines=all.filter(Boolean);lines.dropped=dropped;return lines;
}
/* Dime! Confirmation Note parser (Order History table).
   Row: OrderID  SettleDate  BUY|SELL|REW  SYMBOL [EXCH]  Unit  UnitPrice  USD  Gross  FeeInclVat  WHT  Total
   Unit price on the note is rounded to 2 dp, so price = Gross / Unit. Trade date = Effective Date. */
// OCC option symbol: ROOT + YYMMDD + C|P + strike×1000 (8 digits), e.g. NVTS250912C00005500
export function parseOcc(sym){
  const m=/^([A-Z][A-Z.]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym||'');
  return m?{root:m[1],exp:`20${m[2]}-${m[3]}-${m[4]}`,cp:m[5],strike:+m[6]/1000}:null;
}
export function symLabel(sym){const o=parseOcc(sym);return o?`${o.root} ${o.exp.slice(8,10)}/${o.exp.slice(5,7)}/${o.exp.slice(2,4)} ${o.cp==='C'?'Call':'Put'} $${o.strike}`:sym}
export function parseDime(lines){
  const full=lines.join(' ').replace(/\s+/g,' ');
  if(!/Dime|Confirmation Note|Order History/i.test(full))return[];
  const dmy=s=>{const m=s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);return m?ymd(+m[3],+m[2],+m[1]):''};
  const eff=full.match(/Effective\s*Date\s*(?:\S+\s*){0,6}?(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const N='(\\d[\\d,]*(?:\\.\\d+)?)';
  const re=new RegExp(`(\\d{4,})\\s+(\\d{1,2}\\/\\d{1,2}\\/\\d{4})\\s+(BUY|SELL|SEL|REW|EXC|EXP)\\s+([A-Z][A-Z.\\-]{0,9}?)(\\d{6}[CP]\\d{8})?\\s*(?:\\[[A-Z]+\\]\\s*)?${N}\\s+${N}\\s+USD\\s+${N}\\s+${N}\\s+${N}\\s+${N}`,'g');
  const out=[],seen=new Set();let m;
  while((m=re.exec(full))){
    const [,id,settle,tp,base,occ]=m,[q,up,gross,fee]=m.slice(6,10).map(x=>+x.replace(/,/g,''));
    if(seen.has(id)||!(q>0))continue;seen.add(id);
    const date=(eff&&dmy(eff[1]))||dmy(settle),ref='DIME-'+id,opt=occ?parseOcc(base+occ):null,sym=opt?base+occ:base;
    if(tp==='EXC'||tp==='EXP'){
      if(!opt){(out.other||=[]).push({code:tp,date:dmy(settle)});continue}
      // ปิดสัญญาออปชันที่มูลค่า 0 (ค่าพรีเมียมที่จ่ายไปกลายเป็นขาดทุนที่รับรู้แล้ว)
      out.push({sym,type:'sell',date,qty:q,price:0,fee:0,ref:ref+'-OPT',note:tp==='EXC'?'ใช้สิทธิออปชัน':'ออปชันหมดอายุ'});
      // ใช้สิทธิ: Call = ซื้อหุ้น, Put = ขายหุ้น จำนวน 100 หุ้นต่อสัญญา ที่ราคาใช้สิทธิ
      if(tp==='EXC')out.push({sym:opt.root,type:opt.cp==='C'?'buy':'sell',date,qty:q*100,price:gross>0?+(gross/(q*100)).toFixed(6):opt.strike,fee,ref,note:`ใช้สิทธิ ${symLabel(sym)}`});
      continue;
    }
    out.push({sym,type:/^SEL/.test(tp)?'sell':'buy',date,qty:q,price:gross>0?+(gross/q).toFixed(6):up,fee,ref,note:tp==='REW'?'หุ้นรางวัล':opt?'ออปชัน (ราคาต่อสัญญา)':''});
  }
  return out;
}
