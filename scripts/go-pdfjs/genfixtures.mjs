import fs from 'fs';
function pdf(pages){ // pages: array of content stream strings
  const objs=[];const add=s=>{objs.push(s);return objs.length;};
  const font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const font2=add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const pagesId=objs.length+1+pages.length*2; const kids=[];
  for(const c of pages){const cs=add(`<< /Length ${Buffer.byteLength(c,'latin1')} >>\nstream\n${c}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R /F2 ${font2} 0 R >> >> /Contents ${cs} 0 R >>`));}
  add(`<< /Type /Pages /Kids [${kids.map(k=>k+' 0 R').join(' ')}] /Count ${kids.length} >>`);
  const cat=add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out='%PDF-1.4\n';const off=[];
  objs.forEach((o,i)=>{off.push(out.length);out+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const x=out.length;out+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+off.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('');
  out+=`trailer\n<< /Size ${objs.length+1} /Root ${cat} 0 R >>\nstartxref\n${x}\n%%EOF\n`;return Buffer.from(out,'latin1');}
const cases={
 simple:['BT /F1 12 Tf 72 720 Td (Hello World) Tj ET'],
 lines:['BT /F1 12 Tf 72 720 Td (First line) Tj 0 -14 Td (Second line) Tj 0 -14 Td (Third) Tj ET'],
 gaps:['BT /F1 12 Tf 72 720 Td (Name:) Tj 60 0 Td (Value) Tj ET BT /F1 12 Tf 72 700 Td [(Ker)-30(ned)-400(word)] TJ ET'],
 pages:['BT /F1 12 Tf 72 720 Td (Page one) Tj ET','BT /F2 10 Tf 72 720 Td (Page two text) Tj T* (next) Tj ET','  '],
 para:['BT /F1 11 Tf 13 TL 72 720 Td (Lorem ipsum dolor sit amet,) Tj T* (consectetur adipiscing elit.) Tj T* T* (New paragraph here.) Tj ET'],
 cols:['BT /F1 12 Tf 72 720 Td (Left) Tj ET BT /F1 12 Tf 300 720 Td (Right) Tj ET BT /F1 12 Tf 72 706 Td (L2) Tj ET BT /F1 12 Tf 300 706 Td (R2) Tj ET'],
 chars:['BT /F1 12 Tf 72 720 Td (H) Tj (e) Tj (l) Tj (l) Tj (o) Tj ( ) Tj (x) Tj ET'],
 quote:["BT /F1 12 Tf 14 TL 72 720 Td (a) Tj (b) ' 2 1 (c) \" ET"],
 spacing:['BT /F1 12 Tf 3 Tc 72 720 Td (Spaced) Tj 0 Tc 10 Tw 72 -20 Td (word space test) Tj ET'],
};
fs.mkdirSync('pdfs',{recursive:true});
for(const[k,v]of Object.entries(cases))fs.writeFileSync(`pdfs/${k}.pdf`,pdf(v));
