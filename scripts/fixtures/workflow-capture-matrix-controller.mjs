import {readFile} from 'node:fs/promises';
const settings=JSON.parse(await readFile(process.argv[2],'utf8')),hold=process.argv[3]||'',guarded=process.argv[4]==='guarded';
const capture=guarded?(await import('../workflow-archive-guarded.mjs')).createGuardedWorkflowArchive:(await import('../workflow-archive.mjs')).createWorkflowArchive;
try{const result=await capture({...settings,onPhase:async(phase,value)=>{if(phase===hold){process.send?.({type:'BARRIER',phase,value});await new Promise(ok=>{const receive=m=>{if(m?.type==='CONTINUE'){process.off('message',receive);ok();}};process.on('message',receive);});}}});await new Promise(ok=>process.send({type:'RESULT',result},ok));process.exit(0);}
catch(e){await new Promise(ok=>process.send({type:'ERROR',code:e.code||'UNKNOWN'},ok));process.exit(1);}
