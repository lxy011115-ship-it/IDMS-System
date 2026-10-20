import {readFile} from 'node:fs/promises';
import {GovernanceJobWorkerV4} from '../../server/governance-job-worker-v4.ts';
import {GovernanceJobStoreV4} from '../../server/governance-job-store-v4.ts';
import {GovernanceJobCryptoV4} from '../../server/governance-job-crypto-v4.ts';
import {GovernanceJobAuthV4} from '../../server/governance-job-auth-v4.ts';
import {createAuth} from '../../server/auth.ts';
import {MemoryAuthStore} from '../../server/auth-state.ts';
const c=JSON.parse(await readFile(process.argv[2],'utf8')),queue=new GovernanceJobStoreV4(c.account,c.queueBinding),state=new MemoryAuthStore(),auth=createAuth(c.auth,undefined,state);let once=false;
try{const worker=new GovernanceJobWorkerV4({queue,queueAccount:c.account,account:c.account,binding:c.binding,sources:c.sources,crypto:new GovernanceJobCryptoV4(c.ring,c.queueBinding),auth:new GovernanceJobAuthV4(auth,state),onError:async e=>process.send?.({type:'ERROR',message:e.message}),onPhase:async(phase,value)=>{
 if(phase==='FENCED'&&c.block32&&!once){once=true;process.send?.({type:'BLOCKING',pid:process.pid});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,32000);process.send?.({type:'UNBLOCKED',pid:process.pid});}
 if(phase==='STAGED'&&c.exitAfterStage){await new Promise(ok=>process.send?.({type:'STAGED_EXIT',pid:process.pid},ok));process.exit(0);}
 }});const result=await worker.runOne();process.send?.({type:'RESULT',status:result?.status,id:result?.id,pid:process.pid});}finally{await auth.close();await state.close();}
