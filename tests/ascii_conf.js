const chardet = require('chardet');
const C = require('../dist/charset.js');
const samples = [
  ['empty', ''],
  ['1 byte', 'a'],
  ['10 bytes', 'a'.repeat(10)],
  ['12 ascii', 'hello world\n'],
  ['100 ascii', 'a'.repeat(100)],
  ['english x1', 'The quick brown fox jumps over the lazy dog.'],
  ['english x20', 'The quick brown fox jumps over the lazy dog. '.repeat(20)],
  ['digits', '0123456789'.repeat(50)],
];
for (const [name, s] of samples) {
  const buf = Buffer.from(s, 'ascii');
  const top = chardet.analyse(buf).slice(0,4).map(m => m.name + ':' + m.confidence);
  const d = C.detectCharset(buf);
  console.log(name.padEnd(11), 'len=' + String(buf.length).padEnd(5), 'chardet=[' + top.join(', ') + ']', ' plugin=' + JSON.stringify(d));
}
console.log('--- mixed: ascii + 1/2/4 non-ascii utf8 chars ---');
for (const n of [0,1,2,3,4]) {
  const s = 'a'.repeat(50) + '中'.repeat(n) + 'b'.repeat(50);
  const buf = Buffer.from(s,'utf8');
  const ascii = chardet.analyse(buf).find(m=>m.name==='UTF-8');
  console.log('nonascii=' + n, 'UTF-8 conf=' + (ascii?ascii.confidence:'-'), 'plugin=' + JSON.stringify(C.detectCharset(buf)));
}
