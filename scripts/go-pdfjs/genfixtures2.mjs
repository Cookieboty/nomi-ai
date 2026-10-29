import fs from 'fs';
function build(objs){let out='%PDF-1.4\n';const off=[];objs.forEach((o,i)=>{off.push(out.length);out+=`${i+1} 0 obj\n${o}\nendobj\n`;});
const x=out.length;out+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+off.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('');
out+=`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;return Buffer.from(out,'latin1');}
const st=(d,c)=>`<< ${d} /Length ${Buffer.byteLength(c,'latin1')} >>\nstream\n${c}\nendstream`;
function doc(content,{extraRes='',extra=[],page=''}={}){
 // 1 cat 2 pages 3 page 4 F1 5 content 6 F0(type0) 7 cid 8 tounicode 9 form 10 gs
 const tu='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfrange <0001> <0003> <0041> <0010> <0011> [<4E2D> <6587>] endbfrange 1 beginbfchar <0020> <0020> endbfchar endcmap end end';
 const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
 `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${page} /Resources << /Font << /F1 4 0 R /F0 6 0 R /F2 << /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >> >> /XObject << /X1 9 0 R >> /ExtGState << /G1 10 0 R >> ${extraRes} >> /Contents 5 0 R >>`,
 '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', st('',content),
 '<< /Type /Font /Subtype /Type0 /BaseFont /Foo /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 8 0 R >>',
 '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Foo /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [1 [600 650 700] 32 [250]] >>',
 st('',tu), st('/Type /XObject /Subtype /Form /BBox [0 0 600 800] /Matrix [1 0 0 1 0 -100]','BT /F1 10 Tf 72 600 Td (In form) Tj ET q 1 0 0 1 0 0 cm /X1 Do Q'),
 '<< /Type /ExtGState /Font [4 0 R 9] >>'];
 return build(objs);}
const cases={
 form:'BT /F1 12 Tf 72 720 Td (Before) Tj ET /X1 Do BT /F1 12 Tf 72 400 Td (After) Tj ET',
 cid:'BT /F0 12 Tf 72 720 Td <000100020003002000100011> Tj ET',
 rotated:'q 0 1 -1 0 300 300 cm BT /F1 12 Tf 0 0 Td (Rotated text) Tj 0 -14 Td (line2) Tj ET Q BT /F1 12 Tf 0.7 0.7 -0.7 0.7 100 100 Tm (Diagonal) Tj ET',
 rise:'BT /F1 12 Tf 72 720 Td (E=mc) Tj 5 Ts (2) Tj 0 Ts ( ok) Tj 50 Tz 72 700 Td (squeezed words here) Tj ET',
 gsfont:'BT /G1 gs 72 720 Td (via gs) Tj ET BT /F1 12 Tf 72 700 Td (normal) Tj /F2 12 Tf ( times) Tj /F1 14 Tf (big) Tj ET',
 missing:'BT (no font) Tj /Nope 12 Tf 72 720 Td (fallback) Tj ET 1 2 foo 72 700 Td BT /F1 12 Tf 72 690 Td (after unknown) Tj ET',
 offpage:'BT /F1 12 Tf 72 720 Td (Visible) Tj 1000 0 Td (Hidden) Tj -1000 -20 Td (Again) Tj ET',
 crop:'BT /F1 12 Tf 10 10 Td (corner) Tj 300 300 Td (center) Tj ET',
 tstar:"BT /F1 12 Tf 14 TL 72 720 Td (one) Tj T* (two) Tj (three) ' 2 1 (four) \" ET",
 neg:'BT /F1 12 Tf 200 720 Td (right) Tj -150 0 Td (left) Tj ET BT /F1 12 Tf 72 600 Td [(A) 120 (B) -2000 (C)] TJ ET',
};
fs.mkdirSync('pdfs2',{recursive:true});
for(const [k,c] of Object.entries(cases)) fs.writeFileSync(`pdfs2/${k}.pdf`,doc(c,k==='crop'?{page:'/CropBox [0 0 200 200]'}:{}));
