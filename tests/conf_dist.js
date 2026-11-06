const I = require('iconv-lite');
const chardet = require('chardet');
function top(buf){ const a=chardet.analyse(buf).filter(m=>m.confidence>0); return a.slice(0,3).map(m=>m.name+':'+m.confidence).join(', '); }
const cases = {};
cases['gbk sentence x3'] = I.encode('这是一个用于测试编码探测的中文文件，内容足够长以便让检测器有信心。\n'.repeat(3),'gbk');
cases['gbk sentence x1'] = I.encode('这是一个用于测试编码探测的中文文件，内容足够长以便让检测器有信心。\n','gbk');
cases['gbk short 中文\\n'] = I.encode('中文\n','gbk');
cases['big5 sentence x3'] = I.encode('這是一個用來測試編碼偵測的繁體中文檔案，內容夠長。\n'.repeat(3),'big5');
cases['big5 short'] = I.encode('繁體中文\n','big5');
// realistic GBK C source: ascii code + chinese comments
let c = '';
for (let i=0;i<40;i++){ c += `// 第 ${i} 行：这是中文注释，说明配置项含义。\nint config_${i} = ${i};\n`; }
cases['gbk c-source 40 lines'] = I.encode(c,'gbk');
// realistic GBK ps1 with chinese
let p='';
for (let i=0;i<30;i++){ p += `Write-Host "第 ${i} 行中文输出内容"\n$var_${i} = ${i}\n`; }
cases['gbk ps1 30 lines'] = I.encode(p,'gbk');
// shift_jis
cases['sjis sentence x3'] = I.encode('これは文字コード判定のテスト用に十分長い日本語の文章です。\n'.repeat(3),'shift_jis');
for (const [name,buf] of Object.entries(cases)) {
  console.log(name.padEnd(24), 'len='+String(buf.length).padEnd(6), 'top=['+top(buf)+']');
}
