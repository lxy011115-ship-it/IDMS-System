import {DatabaseSync} from 'node:sqlite';
import {createPublicKey} from 'node:crypto';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import {FieldSpool} from '../../services/field/spool.ts';
if(!process.send||process.env.NODE_ENV!=='test'||!/^fieldspoolqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned field spool QA required');
const native=DatabaseSync.prototype.exec;let fault,spool;
DatabaseSync.prototype.exec=function(sql){
 const pause=()=>{const last=this.prepare("SELECT value FROM metadata WHERE name='last_append'").get().value;process.send({type:'ENTERED',phase:fault,last:JSON.parse(last)});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
 if(sql==='COMMIT'&&fault==='BEFORE')pause();const value=native.call(this,sql);if(sql==='COMMIT'&&fault==='AFTER')pause();return value;
};
process.on('message',m=>{try{
 if(m.type==='OPEN'){const base=resolve('work/field-channel-20261017'),target=resolve(m.directory),rel=relative(base,target);if(isAbsolute(rel)||rel.startsWith('..')||!/^spool-process-[a-f0-9]{10}$/.test(basename(target)))throw Error('Unowned spool path');const publicKey=createPublicKey(m.publicKey),key=Buffer.from(m.eventKey,'base64'),lease=m.lease;try{spool=new FieldSpool(resolve(target,m.file==='after.sqlite'?'after.sqlite':'before.sqlite'),{profile:m.profile,contextLease:lease,eventKey:key,platformPublicKey:publicKey,authorize:()=>lease});}finally{key.fill(0);}process.send({type:'READY'});return;}
 if(m.type==='APPEND'){fault=m.phase;const result=spool.append(m.readId,m.observation);process.send({type:'RESULT',result});return;}
 if(m.type==='CLOSE'){spool?.close();process.send({type:'CLOSED'},()=>process.disconnect());return;}throw Error('Unknown spool QA message');
}catch(e){process.send({type:'ERROR',code:e.code||'FIELD_SPOOL_QA_FAILED'});}});
