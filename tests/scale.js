const fs=require('fs'),path=require('path');
const G=require('../dist/grep.js');
const D=require("./helpers/tmp")("scale");
fs.rmSync(D,{recursive:true,force:true});
let n=0;
for(let d=0; d<50; d++){ const dir=path.join(D,'d'+d); fs.mkdirSync(dir,{recursive:true});
  for(let f=0; f<100; f++){ fs.writeFileSync(path.join(dir,'f'+f+'.txt'), 'line one\nline two target_'+ (f%7) +'\nline three\n'); n++; } }
console.log('created', n, 'files');
(async()=>{
  let t=Date.now();
  const r1=await G.grepTool({pattern:'target_3', limit:1000}, D);
  const m1=Date.now()-t;
  console.log('match pattern: matches='+r1.metadata.matches+' scanned='+r1.metadata.scannedFiles+' read='+r1.metadata.filesRead+' time='+m1+'ms');
  t=Date.now();
  const r2=await G.grepTool({pattern:'zzz_not_present_zzz'}, D);
  const m2=Date.now()-t;
  console.log('no match: output='+JSON.stringify(r2.output)+' scanned='+r2.metadata.scannedFiles+' read='+r2.metadata.filesRead+' time='+m2+'ms');
})();
