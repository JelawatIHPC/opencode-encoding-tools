const fs=require('fs'),path=require('path'),I=require('iconv-lite'); const G=require('../dist/grep.js');
const D=require("./helpers/tmp")("grepdisp2");
fs.rmSync(D,{recursive:true,force:true}); fs.mkdirSync(D,{recursive:true});
const J=p=>path.join(D,p);
fs.writeFileSync(J('gbk_short.c'), I.encode('// 这是另一个中文注释 MARK\n','gbk'));
fs.writeFileSync(J('big5_short.c'), I.encode('// 繁體中文註解 MARK\n','big5'));
fs.writeFileSync(J('de.txt'), I.encode('Grüße und MARK Ümlaute\n','windows-1252'));
fs.writeFileSync(J('ru.txt'), I.encode('Привет мир как дела MARK сегодня\n','windows-1251'));
fs.writeFileSync(J('big.tmp.txt'), 'x'.repeat(6*1024*1024)+'\nMARK_BIG\n');
async function run(label, params){ const r=await G.grepTool(params,D); console.log('=== '+label+' ==='); console.log(r.output); console.log(); }
(async()=>{
  await run('ASCII MARK', {pattern:'MARK'});
  await run('no-match budget detail', {pattern:'zzz_absent_zzz'});
})();
