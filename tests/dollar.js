const fs=require('fs'),path=require('path'); const E=require('../dist/edit.js');
const D=require("./helpers/tmp")("dollartest");
fs.rmSync(D,{recursive:true,force:true}); fs.mkdirSync(D,{recursive:true});
const J=p=>path.join(D,p);
const cases = [
  ['$$', 'A = $$literal$$'],
  ['$&', 'x$&y'],
  ['$1 and $2', 'keep $1 and $2 literal'],
  ['$`', 'backtick $` here'],
  ["$'", "quote $' here"],
  ['${VAR}', 'echo ${VAR}'],
];
let i=0;
for (const [label, nw] of cases){
  const f='c'+(i++)+'.txt';
  fs.writeFileSync(J(f), 'PLACE\nsecond\n','utf8');
  try { E.editTool({path:f, oldString:'PLACE', newString:nw}, D); } catch(e){ console.log('THROW', label, e.message); continue; }
  const got = fs.readFileSync(J(f),'utf8').split('\n')[0];
  console.log((got===nw?'PASS ':'FAIL ')+JSON.stringify(label).padEnd(14)+' => '+JSON.stringify(got)+(got!==nw?(' expected '+JSON.stringify(nw)):''));
}
// replaceAll
fs.writeFileSync(J('all.txt'), 'a$$b a$$b\n','utf8');
E.editTool({path:'all.txt', oldString:'a$$b', newString:'c$$d', replaceAll:true}, D);
console.log('replaceAll =>', JSON.stringify(fs.readFileSync(J('all.txt'),'utf8')));
