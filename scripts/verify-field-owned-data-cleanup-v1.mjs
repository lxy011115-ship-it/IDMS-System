import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash,createHmac,createPublicKey,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readActivationMaterialFile} from './field-activation-material-files.mjs';
import {coldToolingV1,coldStoppedV1} from './pg-cold-image-portable-tools-v1.mjs';
import {publicFieldProfile} from '../services/field/profile.ts';
import {verifyFieldEvent,fieldEventDigest} from '../integrations/field-event.ts';
import {stable} from '../integrations/telemetry.ts';

assert.equal(process.argv.length,3);const nonce=process.argv[2];assert(/^[a-f0-9]{12}$/.test(nonce));
const root=resolve('.'),work=resolve('work/field-owned-data-path-v1-20261024',nonce),hash=b=>createHash('sha256').update(b).digest('hex');
const json=async p=>JSON.parse((await readActivationMaterialFile(p,4*1024**2)).toString('utf8'));
const r=await json(join(work,'verification.private.json'));
assert.equal(r.nonce,nonce);assert(r.passed&&r.cleanupComplete&&r.cleanupErrors.length===0&&r.checks.length===7);
assert(r.workerProof.passed&&r.workerProof.checks.length===6&&r.workerProof.cleanupErrors.length===0);
assert(r.workerExit.code===0&&r.workerExit.signal===null&&r.workerExit.stdoutClosed&&r.workerExit.stderrClosed&&r.workerExit.ipcDisconnected);
assert(r.postgresStopRefusedWhileIntakeHeld&&r.workerProof.signedBusinessAckPositiveCase);
for(const p of r.sourcePins)assert.equal(hash(await readActivationMaterialFile(resolve(p.path),2*1024**2)),p.sha256);
assert.equal(hash(await readFile(process.execPath)),r.node.sha256);
const edges=r.workerProof.edgeProofs;assert.equal(edges.length,5);
for(const p of edges){
  assert(p.normalStop&&p.localDrained&&p.actualExitAndOutputAndIpcClosed&&p.pinsUnchanged&&!p.genericKillUsed&&p.exit.code===0&&p.exit.signal===null);
  const state=p.localState;assert(state.closed&&state.cleanupErrors===0);
  for(const k of ['ready','lockHeld','spoolOpen','readerActive','httpActive','mqttActive','leaseWatching','ackWaiterActive'])assert.equal(state[k],false);
  const dir=join(work,'field-edge-process-'+p.owner),launch=await json(join(dir,'launch.private.json')),terminal=await json(join(dir,'terminal-proof.json')),intent=await json(join(dir,'stop-intent.json'));
  assert.equal(stable(terminal),stable(p));assert.equal(launch.owner,p.owner);assert.equal(launch.parentPid,r.workerExit.pid);assert.equal(intent.pid,p.pid);assert.equal(intent.requestId,p.requestId);
  for(const pin of launch.pins)assert.equal(hash(await readActivationMaterialFile(pin.path,2*1024**2)),pin.sha256);
}
const b=r.workerProof.brokerStop,brokerDir=r.workerProof.brokerDirectory;
const rel=relative(work,brokerDir);assert(!isAbsolute(rel)&&/^mqtt-broker-process-[a-f0-9-]{36}$/.test(rel));
assert(b.normalClose&&!b.genericKillUsed&&b.actualOwnedProcessExit.code===0&&b.actualOwnedProcessExit.signal===null&&b.actualOwnedProcessExit.stdoutClosed&&b.actualOwnedProcessExit.stderrClosed);
const launch=await json(join(brokerDir,'launch-intent.private.json')),stop=await json(join(brokerDir,'stop-control.private.json')),exit=await json(join(brokerDir,'exit-observation.json'));
assert.equal(launch.parentPid,r.workerExit.pid);assert.equal(launch.owner,b.owner);assert.equal(stop.owner,b.owner);assert.equal(stop.requestId,b.requestId);assert(stop.delivered);assert.equal(exit.pid,b.pid);assert.equal(exit.code,0);assert.equal(exit.signal,null);assert(exit.stdoutClosed&&exit.stderrClosed);
if(process.platform==='win32'){assert(stop.completed&&stop.nativeExitCode===0&&stop.helperExit.code===0&&stop.helperExit.signal===null&&b.windowsOriginalHandleWaitCompleted);assert.equal(stop.challengeSha256,hash(launch.challenge));}
else assert(b.linuxSigintHandlerObservedBeforeStop&&stop.signal==='SIGINT');
const cluster=await json(join(r.postgres.work,'cluster.private.json'));
const pgRelative=relative(resolve('work/pg-physical-platform-v1-20261022'),r.postgres.source);assert(/^[a-f0-9]{12}[\\/]source$/.test(pgRelative));
assert.equal(cluster.source,r.postgres.source);assert.equal(cluster.authority.port,r.postgres.port);assert.notEqual(r.postgres.port,45432);
const tooling=await coldToolingV1(cluster.bin),control=await coldStoppedV1(r.postgres.source,tooling,r.postgres.systemIdentifier);
assert(control);await assert.rejects(lstat(join(r.postgres.source,'postmaster.pid')),{code:'ENOENT'});assert(r.postgresProcesses.every(p=>p.stopped));
const names=(await import('node:fs/promises')).readdir;
const files=(await names(join(work,'edge-spool'))).filter(n=>/^stream-[a-f0-9]{64}\.sqlite$/.test(n));assert.equal(files.length,1);
const q=new DatabaseSync(join(work,'edge-spool',files[0]),{readOnly:true});let key;let pendingCount,sequence;
try{
  assert.equal(Object.values(q.prepare('PRAGMA quick_check').get())[0],'ok');assert.equal(Object.values(q.prepare('PRAGMA application_id').get())[0],0x49444631);assert.equal(Object.values(q.prepare('PRAGMA user_version').get())[0],1);
  const rows=q.prepare('SELECT name,value FROM metadata ORDER BY name').all(),m=Object.fromEntries(rows.map(x=>[x.name,x.value])),{state_mac,...meta}=m;
  key=await readActivationMaterialFile(join(work,'event.bin'),32);assert.equal(key.length,32);
  const mac=createHmac('sha256',key).update('idms:field-spool-state:1\n'+stable(meta)+'\n');
  const profile=publicFieldProfile(await json(join(work,'profile.json'))),publicKey=createPublicKey(await readActivationMaterialFile(join(work,'platform-public.pem'),16384));
  const pending=q.prepare('SELECT * FROM pending ORDER BY sequence_no').all();
  for(const row of pending){
    const event=verifyFieldEvent(JSON.parse(row.payload),key,profile,publicKey);assert.equal(event.eventId,row.event_id);assert.equal(event.sequenceNo,row.sequence_no);assert.equal(fieldEventDigest(event),row.digest);assert.equal(event.streamId,m.binding_digest);
    mac.update('P'+stable({...row,payload:hash(row.payload)})+'\n');
  }
  for(const row of q.prepare('SELECT * FROM acknowledged ORDER BY sequence_no').all())mac.update('A'+stable({...row,ack:hash(row.ack)})+'\n');
  assert(timingSafeEqual(mac.digest(),Buffer.from(state_mac,'hex')));pendingCount=pending.length;sequence=Number(m.sequence);
  assert.equal(pendingCount,profile.points.length);assert.equal(pendingCount,edges.at(-1).localState.lastSpool.pending);assert.equal(sequence,edges.at(-1).localState.lastSpool.sequence);
}finally{key?.fill(0);q.close();}
console.log(JSON.stringify({format:'IDMS_FIELD_OWNED_DATA_PATH_INDEPENDENT_V1',nonce,readOnly:true,nativePassed:true,nativeChecks:7,ownedEdgeRootsVerified:5,brokerNormalStopVerified:true,postgresCleanOffline:true,sourcePinsVerified:r.sourcePins.length,retainedPendingEventsVerified:pendingCount,retainedSequence:sequence,spoolStateMacVerified:true,pendingEventSignaturesVerified:true,offlineSqlRowsRequeried:false,allProductionDependenciesRegistered:false,fullGoalComplete:false}));
