import {readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {coldNeedV1 as need} from './pg-cold-image-manifest-v1.mjs';
import {coldToolingV1,coldStoppedV1} from './pg-cold-image-tools-v1.mjs';
// Read-only audit. It never stops a process, deletes a path, or trusts an
// arbitrary PGDATA path supplied by a verification file.
const nonces=process.argv.slice(2);need(nonces.length>0&&nonces.length<=20&&new Set(nonces).size===nonces.length&&nonces.every(n=>/^[a-f0-9]{12}$/.test(n)),'COLD_QA_NONCES');
const tooling=await coldToolingV1(await realpath(join(process.env.LOCALAPPDATA,'IDMS/runtime/pgsql/bin'))),rows=[];
for(const nonce of nonces){const root=resolve('work/pg-cold-image-v1-20261022',nonce),proof=JSON.parse(await readFile(join(root,'verification.json'),'utf8'));need(proof.nonce===nonce&&proof.format==='IDMS_PG_COLD_IMAGE_FOUNDATION_QA_V1'&&Array.isArray(proof.processes)&&proof.processes.length>0&&proof.processes.length<=2,'COLD_QA_PROOF');
 for(const p of proof.processes){const expected=[join(root,'source'),join(root,'restored')];need(expected.includes(p.directory)&&Number.isInteger(p.pid)&&p.pid>0&&Number.isInteger(p.port)&&p.port>1024&&p.port<65536&&p.port!==45432&&/^\d{10,25}$/.test(p.systemIdentifier),'COLD_QA_OWNERSHIP');const control=await coldStoppedV1(p.directory,tooling,p.systemIdentifier);let alive=false;try{process.kill(p.pid,0);alive=true;}catch(e){need(e.code==='ESRCH','COLD_QA_PID_CHECK');}need(!alive,'COLD_QA_PID_STILL_PRESENT');rows.push({nonce,directory:p.directory.endsWith('source')?'source':'restored',pid:p.pid,port:p.port,systemIdentifier:control.systemIdentifier,state:control.state,pidAbsent:true,originalQaPassed:proof.passed,originalStoppedFlag:p.stopped});}}
console.log(JSON.stringify({readOnly:true,ownedClusters:rows.length,allCleanlyStopped:true,allPostmasterPidsAbsent:true,privateArtifactsRetained:true,originalClusterTouched:false,rows}));
