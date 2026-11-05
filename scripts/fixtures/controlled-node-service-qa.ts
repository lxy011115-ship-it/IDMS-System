// Synthetic pending work; no application configuration, credentials or database.
import {writeFile} from 'node:fs/promises';
import {installRuntimeStop} from '../../services/runtime-stop.ts';
const [proof,delay]=process.argv.slice(2);
let release!:()=>void,stops=0;
const gate=new Promise<void>(resolve=>{release=resolve;});
const admission=setInterval(()=>{},1000);
const pending=(async()=>{await gate;await new Promise(resolve=>setTimeout(resolve,Number(delay)));})();
installRuntimeStop(async()=>{
  stops++;clearInterval(admission);release();await pending;
  await writeFile(proof,JSON.stringify({format:'IDMS_SYNTHETIC_DRAIN_V1',stops,pendingCompleted:true,pid:process.pid}),{flag:'wx'});
},'edge');
process.send?.({type:'IDMS_QA_READY_V1'});
