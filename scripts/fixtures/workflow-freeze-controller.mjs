// QA-only process barrier; production config/CLI has no fault switches.
import {readFile} from 'node:fs/promises';
import {runWorkflowFreeze} from '../workflow-freeze-control.mjs';
const file=process.argv[2],operation=process.argv[3],action=process.argv[4],hold=process.argv[5]||'';
const config=JSON.parse(await readFile(file,'utf8'));
try{
 const result=await runWorkflowFreeze(config,operation,action,{onPhase:async(phase,connection)=>{
  process.send?.({type:'PHASE',phase});
  if(phase!==hold)return;process.send?.({type:'BARRIER',phase,connection});await new Promise(ok=>{process.on('message',message=>{if(message?.type==='CONTINUE')ok();});});
 }});await new Promise(ok=>process.send?process.send({type:'RESULT',result},ok):ok());process.exit(0);
}catch(e){await new Promise(ok=>process.send?process.send({type:'ERROR',code:e.code||'UNKNOWN',message:String(e.message).slice(0,300)},ok):ok());process.exit(1);}
