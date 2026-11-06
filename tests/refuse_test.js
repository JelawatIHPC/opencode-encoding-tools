const fs=require('fs'), path=require('path');
const I=require('iconv-lite');
const C=require('../dist/charset.js');
const W=require('../dist/write.js'), E=require('../dist/edit.js'), P=require('../dist/patch.js');
const D=require("./helpers/tmp")("refuse");
fs.rmSync(D,{recursive:true,force:true}); fs.mkdirSync(D,{recursive:true});
const J=p=>path.join(D,p);
const abs=p=>p.replace(/\\/g,'/');
const emoji=String.fromCodePoint(0x1F600);
const base='這是一個繁體中文檔案，內容夠長讓檢測器有信心。'.repeat(3)+'\n';
function mk(name,text,enc){ fs.writeFileSync(J(name), I.encode(text,enc)); }
function tryIt(label, fn){ try{ const r=fn(); console.log(' ', label, '=> OK', r===undefined?'':r); }catch(e){ console.log(' ', label, '=> THROW:', e.message.slice(0,120)); } }
console.log('== write existing big5, no charset ==');
mk('b5.txt', base, 'big5');
tryIt('representable Chinese', ()=>{ W.writeTool({filePath:'b5.txt', content:'繁體中文新內容\n'}, D); return 'bytes='+fs.readFileSync(J('b5.txt')).subarray(0,8).toString('hex'); });
console.log('  detect after:', JSON.stringify(C.detectCharset(fs.readFileSync(J('b5.txt')))));
tryIt('emoji (unrepresentable)', ()=>W.writeTool({filePath:'b5.txt', content:'繁體'+emoji+'\n'}, D));
console.log('== write new, no charset ==');
tryIt('new file + emoji', ()=>{ W.writeTool({filePath:'new.txt', content:'x'+emoji+'\n'}, D); return 'utf8='+fs.readFileSync(J('new.txt')).toString('utf8'); });
console.log('== edit existing big5, no charset ==');
mk('e_b5.txt', base+'第二行\n', 'big5');
tryIt('edit representable', ()=>{ E.editTool({path:'e_b5.txt', oldString:'第二行', newString:'第二行改'}, D); return 'ok'; });
tryIt('edit -> emoji', ()=>E.editTool({path:'e_b5.txt', oldString:'第二行改', newString:'第二'+emoji}, D));
console.log('== gb18030 covers Unicode (no error) ==');
mk('g.txt', '这是一个中文文件，内容足够长以便检测。'.repeat(3)+'\n', 'gbk');
tryIt('gbk file + emoji no charset', ()=>{ W.writeTool({filePath:'g.txt', content:'中文'+emoji+'\n'}, D); const b=fs.readFileSync(J('g.txt')); return 'len='+b.length+' decode='+I.decode(b,'gbk'); });
console.log('== patch: no charset, big5 file + emoji => skip ==');
mk('p_b5.txt', base+'第二行\n', 'big5');
fs.writeFileSync(J('p_ok.txt'),'alpha\nbeta\n','utf8');
const pt='*** Begin Patch\n*** Update File: '+abs(J('p_ok.txt'))+'\n@@\n-beta\n+beta2\n*** Update File: '+abs(J('p_b5.txt'))+'\n@@\n-第二行\n+第二'+emoji+'\n*** End Patch\n';
try{ const r=P.patchTool({patchText:pt}, D); console.log('  output:\n'+r.output); }catch(e){ console.log('  THROW:', e.message); }
console.log('  p_ok:', JSON.stringify(fs.readFileSync(J('p_ok.txt'),'utf8')));
