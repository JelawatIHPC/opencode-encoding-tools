const fs=require("fs"), path=require("path");
const W=require("../dist/write.js"), E=require("../dist/edit.js"), P=require("../dist/patch.js");
const D=require("./helpers/tmp")("eol2");
fs.rmSync(D,{recursive:true,force:true}); fs.mkdirSync(D,{recursive:true});
function rep(name){ const b=fs.readFileSync(path.join(D,name)); const crlf=b.filter?0:b.toString("latin1").split("\r\n").length-1; const s=b.toString("latin1"); const c=(s.match(/\r\n/g)||[]).length; const l=(s.replace(/\r\n/g,"").match(/\n/g)||[]).length; return `CRLF=${c} loneLF=${l}`; }
function hasWarn(r){ return /Warning:/.test(r.output); }
function run(label, fn, file){ const r=fn(); console.log(label.padEnd(34), "warn="+(hasWarn(r)?"YES":"no"), "|", file?rep(file):""); if(hasWarn(r)) console.log("    "+r.output.split("\n\n").slice(1).join(" ").slice(0,150)); }

// write scenarios
run("W1 new pure LF", ()=>W.writeTool({filePath:"w1.txt",content:"a\nb\n"},D), "w1.txt");
run("W2 new pure CRLF", ()=>W.writeTool({filePath:"w2.txt",content:"a\r\nb\r\n"},D), "w2.txt");
run("W3 new mixed", ()=>W.writeTool({filePath:"w3.txt",content:"a\r\nb\n"},D), "w3.txt");
fs.writeFileSync(path.join(D,"w4.txt"),"a\nb\n"); run("W4 existing LF <- pure CRLF", ()=>W.writeTool({filePath:"w4.txt",content:"x\r\ny\r\n"},D), "w4.txt");
fs.writeFileSync(path.join(D,"w5.txt"),"a\r\nb\r\n"); run("W5 existing CRLF <- pure LF", ()=>W.writeTool({filePath:"w5.txt",content:"x\ny\n"},D), "w5.txt");
fs.writeFileSync(path.join(D,"w6.txt"),"a\r\nb\r\n"); run("W6 existing CRLF <- mixed", ()=>W.writeTool({filePath:"w6.txt",content:"x\r\ny\n"},D), "w6.txt");

// edit scenarios
fs.writeFileSync(path.join(D,"e1.txt"),"one\r\ntwo\r\nthree\r\n"); run("E1 CRLF file, pure LF old/new", ()=>E.editTool({path:"e1.txt",oldString:"one\ntwo",newString:"one\nTWO"},D), "e1.txt");
fs.writeFileSync(path.join(D,"e2.txt"),"one\r\ntwo\r\n"); run("E2 CRLF file, mixed new", ()=>E.editTool({path:"e2.txt",oldString:"two",newString:"T\r\nWO\nX"},D), "e2.txt");
fs.writeFileSync(path.join(D,"e3.txt"),"one\ntwo\n"); run("E3 LF file, pure CRLF old/new", ()=>E.editTool({path:"e3.txt",oldString:"one\r\ntwo",newString:"one\r\nTWO"},D), "e3.txt");

// patch scenarios
const abs=p=>p.replace(/\\/g,"/");
run("P1 patch add (new file)", ()=>P.patchTool({patchText:`*** Begin Patch\n*** Add File: ${abs(D)}/p1.txt\n+hello\n+world\n*** End Patch\n`},D), "p1.txt");
fs.writeFileSync(path.join(D,"p2.txt"),"a\r\nb\r\n");
run("P2 patch mixed text warning", ()=>P.patchTool({patchText:`*** Begin Patch\n*** Update File: ${abs(D)}/p2.txt\n@@\n-a\r\n+b\r\n*** End Patch\n`},D), "p2.txt");
