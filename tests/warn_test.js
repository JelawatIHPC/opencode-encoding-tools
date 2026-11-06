const fs=require('fs'), path=require('path');
const I=require('iconv-lite');
const C=require('../dist/charset.js');
const W=require('../dist/write.js'), E=require('../dist/edit.js'), P=require('../dist/patch.js');
const D=require("./helpers/tmp")("warn");
fs.rmSync(D,{recursive:true,force:true}); fs.mkdirSync(D,{recursive:true});
const J=p=>path.join(D,p); const abs=p=>p.replace(/\\/g,'/');
function mk(name,text,enc){ fs.writeFileSync(J(name), I.encode(text,enc)); }
const hasW = r => /Warning:/.test(r.output);
function show(label, r){ console.log((hasW(r)?'[WARN] ':'[     ] ')+label); if(hasW(r)) console.log('        '+r.output.split('\n\n').slice(1).join(' | ').slice(0,230)); }
const utf8txt='这是 UTF-8 中文内容。\n'; const gbkBig='这是一个用于测试编码探测的中文文件，内容足够长以便让检测器有信心。'.repeat(3)+'\n';
mk('utf8.txt', utf8txt, 'utf8'); mk('ascii.txt','hello world\n','utf8');
mk('gbk_big.txt', gbkBig, 'gbk'); mk('gbk_short.txt','中文\n','gbk'); mk('big5_short.txt','繁體中文\n','big5');
mk('ru.txt','Это тестовый текст на русском языке.\n','windows-1251');
mk('de.txt','Dies ist ein deutscher Testtext mit Umlauten äöüß.\n','windows-1252');
console.log('== detectCharset ==');
for(const n of ['utf8.txt','ascii.txt','gbk_big.txt','gbk_short.txt','big5_short.txt','ru.txt','de.txt']){
  const d=C.detectCharset(fs.readFileSync(J(n)));
  console.log('  '+n.padEnd(15), d.encoding.padEnd(13), 'def='+d.definite, 'warn='+d.warn, 'conf='+(d.confidence??'-'), 'src='+d.source);
}
console.log('== UTF-8 / ASCII never warn ==');
show('write over utf8.txt (chinese)', W.writeTool({filePath:'utf8.txt',content:'新的 UTF-8 中文内容。\n'},D));
show('edit utf8.txt', E.editTool({path:'utf8.txt',oldString:'新的',newString:'新改的'},D));
show('write over ascii.txt', W.writeTool({filePath:'ascii.txt',content:'another ascii line\n'},D));
console.log('== authoritative non-UTF-8 (100) silent ==');
show('write over gbk_big.txt', W.writeTool({filePath:'gbk_big.txt',content:gbkBig.replace('信心','把握')},D));
console.log('== ambiguous non-UTF-8 => warn, still written ==');
show('write over gbk_short.txt', W.writeTool({filePath:'gbk_short.txt',content:'中文改写\n'},D));
console.log('     gbk_short bytes:', fs.readFileSync(J('gbk_short.txt')).toString('hex'), '(gb18030 of 中文改写)');
show('write over big5_short.txt', W.writeTool({filePath:'big5_short.txt',content:'繁體中文\n'},D));
console.log('     big5_short bytes:', fs.readFileSync(J('big5_short.txt')).toString('hex'), '(big5 of 繁體中文)');
show('write over big5_short.txt WITH charset big5', W.writeTool({filePath:'big5_short.txt',content:'繁體中文\n',charset:'big5'},D));
console.log('== SBCS ambiguous => warn (edit still matches) ==');
show('edit ru.txt (cp1251, conf40)', E.editTool({path:'ru.txt',oldString:'тестовый',newString:'ТЕСТОВЫЙ'},D));
console.log('     ru bytes stay cp1251:', fs.readFileSync(J('ru.txt')).toString('hex').slice(0,20));
show('edit ru.txt WITH charset windows-1251', E.editTool({path:'ru.txt',oldString:'ТЕСТОВЫЙ',newString:'тестовый'},D));
show('edit de.txt (conf82, single)', E.editTool({path:'de.txt',oldString:'Testtext',newString:'TestText'},D));
console.log('== patch: only non-UTF-8 file warns ==');
fs.writeFileSync(J('p_utf8.txt'),'utf8 line\n','utf8'); mk('p_big5.txt','繁體中文\n','big5');
const pt='*** Begin Patch\n*** Update File: '+abs(J('p_utf8.txt'))+'\n@@\n-utf8 line\n+utf8 changed\n*** Update File: '+abs(J('p_big5.txt'))+'\n@@\n-繁體中文\n+繁體改\n*** End Patch\n';
try{ const r=P.patchTool({patchText:pt},D); console.log('  output:\n'+r.output.split('\n').map(l=>'    '+l).join('\n')); }catch(e){ console.log('  THROW:', e.message.slice(0,200)); }
