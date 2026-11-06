const fs=require('fs'), path=require('path');
const I=require('iconv-lite');
const C=require('../dist/charset.js');
const R=require('../dist/read.js'), W=require('../dist/write.js'), E=require('../dist/edit.js'), P=require('../dist/patch.js');
const D=require("./helpers/tmp")("cset");
fs.rmSync(D,{recursive:true,force:true}); fs.mkdirSync(D,{recursive:true});
const J=p=>path.join(D,p);
function writeEnc(name,text,enc){ fs.writeFileSync(J(name), I.encode(text,enc)); }
function bytes(name){ return fs.readFileSync(J(name)); }
writeEnc('gbk_big.txt','这是一个用于测试编码探测的中文文件，内容足够长以便让检测器有信心。'.repeat(3)+'\n','gbk');
writeEnc('gbk_short.txt','中文\n','gbk');
fs.writeFileSync(J('utf8_cn.txt'),'这是一段中文 UTF-8 文本。\n','utf8');
fs.writeFileSync(J('ascii.txt'),'hello world\n','utf8');
writeEnc('big5_big.txt','這是一個用來測試編碼偵測的繁體中文檔案，內容夠長。'.repeat(3)+'\n','big5');
writeEnc('gbk_edit.txt','第一行\n第二行\n第三行\n','gbk');
console.log('== detectCharset ==');
for (const n of ['gbk_big.txt','gbk_short.txt','utf8_cn.txt','ascii.txt','big5_big.txt']) {
  console.log(' ', n, JSON.stringify(C.detectCharset(fs.readFileSync(J(n)))));
}
function tryThrow(label, fn){ try { const r=fn(); console.log(' ', label, '=> OK', typeof r==='string'?r:''); } catch(e){ console.log(' ', label, '=> THROW:', e.message.slice(0,170)); } }
console.log('== resolveCharset (existing) ==');
const gbkBig=fs.readFileSync(J('gbk_big.txt'));
const ascii=fs.readFileSync(J('ascii.txt'));
tryThrow('confident gbk + charset gbk', ()=>C.resolveCharset(gbkBig,'gbk').encoding);
tryThrow('confident gbk + charset big5', ()=>C.resolveCharset(gbkBig,'big5').encoding);
tryThrow('confident gbk + charset utf-8', ()=>C.resolveCharset(gbkBig,'utf-8').encoding);
tryThrow('ascii + charset gbk', ()=>C.resolveCharset(ascii,'gbk').encoding);
tryThrow('ascii + charset utf-16le', ()=>C.resolveCharset(ascii,'utf-16le').encoding);
tryThrow('ascii + charset x-unknown', ()=>C.resolveCharset(ascii,'x-unknown').encoding);
console.log('== resolveCharsetForContent / normalize ==');
tryThrow('new content gbk', ()=>C.resolveCharsetForContent('中文abc','gbk'));
tryThrow('new content gbk + emoji', ()=>C.resolveCharsetForContent('中文'+String.fromCodePoint(0x1F600),'gbk'));
tryThrow('normalize GBK', ()=>C.normalizeCharsetParam('GBK'));
tryThrow('normalize gb2312', ()=>C.normalizeCharsetParam('gb2312'));
tryThrow('normalize bogus', ()=>C.normalizeCharsetParam('no-such'));
console.log('== readTool ==');
tryThrow('read gbk_big default charset', ()=>R.readTool({filePath:'gbk_big.txt'},D).metadata.charset);
tryThrow('read gbk_big charset gbk', ()=>R.readTool({filePath:'gbk_big.txt',charset:'gbk'},D).metadata.charset);
tryThrow('read gbk_big charset big5', ()=>R.readTool({filePath:'gbk_big.txt',charset:'big5'},D).metadata.charset);
console.log('== writeTool new ==');
tryThrow('write new gbk', ()=>{ W.writeTool({filePath:'out_gbk.txt',content:'中文内容\n',charset:'gbk'},D); return 'bytes='+bytes('out_gbk.txt').toString('hex'); });
tryThrow('write new gbk+emoji', ()=>W.writeTool({filePath:'out_bad.txt',content:'x'+String.fromCodePoint(0x1F600)+'\n',charset:'gbk'},D));
console.log('== editTool ==');
tryThrow('edit gbk charset gbk', ()=>{ E.editTool({path:'gbk_edit.txt',oldString:'第二行',newString:'第二行改',charset:'gbk'},D); return 'ok'; });
tryThrow('edit gbk charset big5', ()=>E.editTool({path:'gbk_edit.txt',oldString:'第三行',newString:'第三行改',charset:'big5'},D));
console.log('== patch partial success ==');
fs.writeFileSync(J('p_ascii.txt'),'alpha\nbeta\n','utf8');
writeEnc('p_gbk.txt','第一行\n第二行\n','gbk');
const abs=p=>p.replace(/\\/g,'/');
const patchText='*** Begin Patch\n*** Update File: '+abs(J('p_ascii.txt'))+'\n@@\n-beta\n+beta2\n*** Update File: '+abs(J('p_gbk.txt'))+'\n@@\n-第二行\n+第二行改\n*** End Patch\n';
try { const r=P.patchTool({patchText,charset:'big5'},D); console.log('  output:\n'+r.output); console.log('  failures:', JSON.stringify(r.metadata.failures)); } catch(e){ console.log('  patch THROW:', e.message); }
console.log('  p_ascii:', JSON.stringify(fs.readFileSync(J('p_ascii.txt'),'utf8')));
