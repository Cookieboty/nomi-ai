import fs from 'fs';
const {extractText,getDocumentProxy}=await import('/workspace/wt-205-b8/node_modules/unpdf/dist/index.mjs');
const res={};
for(const f of fs.readdirSync('pdfs').sort()){const pdf=await getDocumentProxy(new Uint8Array(fs.readFileSync('pdfs/'+f)));
 const {text}=await extractText(pdf,{mergePages:false});res[f]=text;}
console.log(JSON.stringify(res,null,1));
