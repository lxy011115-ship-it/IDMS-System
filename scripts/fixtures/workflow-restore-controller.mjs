import {readFile} from 'node:fs/promises';
import {resumeWorkflowRestore} from '../workflow-restore-resumer.mjs';
const settings=JSON.parse(await readFile(process.argv[2],'utf8')),hold=process.argv[3]||'';
try{const result=await resumeWorkflowRestore({...settings,onPhase:async(phase,value)=>{process.send?.({type:'PHASE',phase,value});if(hold.split(',').includes(phase)){process.send?.({type:'BARRIER',phase,value});await new Promise(ok=>{const resume=m=>{if(m?.type==='CONTINUE'){process.off('message',resume);ok();}};process.on('message',resume);});}}});await new Promise(ok=>process.send?process.send({type:'RESULT',result},ok):ok());process.exit(0);}
catch(e){await new Promise(ok=>process.send?process.send({type:'ERROR',code:e.code||'UNKNOWN',message:String(e.message).slice(0,600),location:String(e.stack).split('\n').slice(1,8).join('\n')},ok):ok());process.exit(1);}
