const fs=require('fs'), path=require('path');
const I=require('iconv-lite');
const C=require('../dist/charset.js');
const R=require('../dist/read.js'), W=require('../dist/write.js'), P=require('../dist/patch.js');
const D=require("./helpers/tmp")("cset2");
fs.rmSync(D,{recursive:true,force:true}); fs.mkdirSync(D,{recursive:true});
const J=p=>path.join(D,p);
function writeEnc(name,text,enc){ fs.writeFileSync(J(name), I.encode(text,enc)); }
function bytes(name){ return fs.readFileSync(J(name)); }
function tryThrow(label, fn){ try { const r=fn(); console.log(' ', label, '=> OK', r===undefined?'':r); } catch(e){ console.log(' ', label, '=> THROW:', e.message.replace(/\n/g,' ').slice(0,200)); } }
writeEnc('gbk_big.txt','这是一个用于测试编码探测的中文文件，内容足够长以便让检测器有信心。'.repeat(3)+'\n','gbk');
writeEnc('gbk_short.txt','中文\n','gbk');
writeEnc('big5_big.txt','這是一個用來測試編碼偵測的繁體中文檔案，內容夠長。'.repeat(3)+'\n','big5');
const emoji=String.fromCodePoint(0x1F600);
console.log('== new-file encodability ==');
tryThrow('new big5 + emoji', ()=>C.resolveCharsetForContent('繁體'+emoji,'big5'));
tryThrow('new shift_jis + emoji', ()=>C.resolveCharsetForContent('日本'+emoji,'shift_jis'));
console.log('== confident big5 mismatch ==');
tryThrow('confident big5 + charset gbk', ()=>C.resolveCharset(fs.readFileSync(J('big5_big.txt')),'gbk').encoding);
console.log('== impossible reason ==');
tryThrow('3-byte ascii + utf-16le', ()=>C.resolveCharset(Buffer.from('abc','ascii'),'utf-16le').encoding);
tryThrow('valid gb18030 bytes + utf-8 imposs', ()=>{ const b=I.encode('中文内容','gbk'); return C.resolveCharsetForContent('',undefined) && C.strictDecode(b,'utf8')===null ? 'utf8 invalid as expected' : 'unexpected'; });
console.log('== short gbk explicit ==');
tryThrow('read gbk_short charset gbk', ()=>JSON.stringify(R.readTool({filePath:'gbk_short.txt',charset:'gbk'},D).metadata.charset));
console.log('== patch: confident mismatch -> skipped, other applied ==');
fs.writeFileSync(J('p_ascii.txt'),'alpha\nbeta\n','utf8');
writeEnc('p_gbk_big.txt','第一行\n第二行\n第三行\n','gbk');
// make gbk_big confident by padding
writeEnc('p_gbk_big.txt',('中文内容行，足够长以便检测出编码。'.repeat(4)+'\n第二行\n'),'gbk');
const abs=p=>p.replace(/\\/g,'/');
const patchText='*** Begin Patch\n*** Update File: '+abs(J('p_ascii.txt'))+'\n@@\n-beta\n+beta2\n*** Update File: '+abs(J('p_gbk_big.txt'))+'\n@@\n-第二行\n+第二行改\n*** End Patch\n';
try { const r=P.patchTool({patchText,charset:'big5'},D); console.log('  output:\n'+r.output); } catch(e){ console.log('  patch THROW:', e.message); }
console.log('  p_ascii:', JSON.stringify(fs.readFileSync(J('p_ascii.txt'),'utf8')));
console.log('== patch add with charset gbk ==');
const addText='*** Begin Patch\n*** Add File: '+abs(J('added.txt'))+'\n+新文件内容\n+第二行\n*** End Patch\n';
try { const r=P.patchTool({patchText:addText,charset:'gbk'},D); console.log('  output:', r.output); console.log('  added bytes:', bytes('added.txt').toString('hex')); } catch(e){ console.log('  THROW:', e.message); }
console.log('== patch add with charset big5 + emoji => skipped ==');
const addText2='*** Begin Patch\n*** Add File: '+abs(J('added_bad.txt'))+'\n+繁體'+emoji+'\n*** End Patch\n';
try { const r=P.patchTool({patchText:addText2,charset:'big5'},D); console.log('  output:', r.output); console.log('  exists:', fs.existsSync(J('added_bad.txt'))); } catch(e){ console.log('  THROW:', e.message.replace(/\n/g,' ')); }
