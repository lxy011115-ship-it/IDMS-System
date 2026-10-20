import {randomUUID} from 'node:crypto';
const failure=code=>Object.assign(Error(code),{code});
export function maintenanceBridge(nonce){
 if(typeof process.send!=='function'||!process.connected||typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce))throw failure('FIELD_MAINTENANCE_BRIDGE_INVALID');
 let active=false;
 return async request=>{
  if(active)throw failure('FIELD_MAINTENANCE_BRIDGE_BUSY');active=true;const id=randomUUID();let timer,listener,disconnected;
  try{return await new Promise((ok,no)=>{
   listener=m=>{if(m?.type!=='FIELD_MAINTENANCE_REVIEW_REPLY'||m.nonce!==nonce||m.id!==id)return;ok(m.value);};
   disconnected=()=>no(failure('FIELD_MAINTENANCE_SUPERVISOR_CLOSED'));process.on('message',listener);process.once('disconnect',disconnected);
   timer=setTimeout(()=>no(failure('FIELD_MAINTENANCE_SUPERVISOR_TIMEOUT')),90000);
   process.send({type:'FIELD_MAINTENANCE_REVIEW',nonce,id,...request},e=>{if(e)no(failure('FIELD_MAINTENANCE_SUPERVISOR_CLOSED'));});
  });}finally{clearTimeout(timer);process.off('message',listener);process.off('disconnect',disconnected);active=false;}
 };
}
