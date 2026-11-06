const fs=require('fs'), path=require('path');
const I=require('iconv-lite');
const E=require('../dist/edit.js'), P=require('../dist/patch.js');
const D=require("./helpers/tmp")("warn2");
fs.rmSync(D,{recursive:true,force:true}); fs.mkdirSync(D,{recursive:true});
const J=p=>path.join(D,p); const abs=p=>p.replace(/\\/g,'/');
function mk(name,text,enc){ fs.writeFileSync(J(name), I.encode(text,enc)); }
const hasW=r=>/Warning:/.test(r.output);
function show(label, fn){ try{ const r=fn(); console.log((hasW(r)?'[WARN] ':'[     ] ')+label); if(hasW(r)) console.log('        '+r.output.split('\n\n').slice(1).join(' | ').slice(0,200)); }catch(e){ console.log('[ERROR] '+label+'\n        '+e.message.replace(/\n/g,' ').slice(0,260)); } }
mk('ru.txt','Это тестовый текст на русском языке.\n','windows-1251');
mk('b5.txt','繁體中文\n','big5');
console.log('== suppression: charset provided => silent ==');
show('edit ru WITH charset windows-1251', ()=>E.editTool({path:'ru.txt',oldString:'тестовый',newString:'ТЕСТОВЫЙ',charset:'windows-1251'},D));
show('edit ru WITHOUT charset => warn', ()=>E.editTool({path:'ru.txt',oldString:'ТЕСТОВЫЙ',newString:'тестовый'},D));
console.log('== ambiguous patch that MATCHES => warn on that file only ==');
fs.writeFileSync(J('u.txt'),'line one\n','utf8');
const pt='*** Begin Patch\n*** Update File: '+abs(J('u.txt'))+'\n@@\n-line one\n+line 1\n*** Update File: '+abs(J('ru.txt'))+'\n@@\n-Это тестовый текст на русском языке.\n+Это изменённый текст.\n*** End Patch\n';
try{ const r=P.patchTool({patchText:pt},D); console.log(r.output.split('\n').map(l=>'    '+l).join('\n').slice(0,600)); }catch(e){ console.log('  THROW:', e.message.slice(0,300)); }
console.log('== ambiguous edit that FAILS to match => error carries charset hint ==');
show('edit b5.txt (wrong guess) => hint', ()=>E.editTool({path:'b5.txt',oldString:'繁體中文',newString:'繁體改'},D));
