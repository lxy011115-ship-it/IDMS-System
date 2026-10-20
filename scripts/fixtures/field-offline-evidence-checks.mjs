import assert from 'node:assert/strict';
import {readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import {fork} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {fieldSha256} from '../../integrations/field-profile.ts';
import {fieldLeaseKeyId} from '../../integrations/field-lease.ts';
import {canonical} from '../../server/imports.ts';
import {writePrivate} from '../keycloak-local.mjs';

export async function exerciseOfflineFieldEvidence(handoff){
 const base=await realpath(resolve('work/field-channel-20261017'));assert.match(handoff.directory,/^offline-evidence-[a-f0-9]{10}$/);const directory=await realpath(resolve(base,handoff.directory)),rel=relative(base,directory);assert.ok(!isAbsolute(rel)&&!rel.startsWith('..')&&basename(directory)===handoff.directory);const file=name=>resolve(directory,name),input=JSON.parse(await readFile(file('handoff.json'))),original=await readFile(file('pack.json'));
 assert.equal(input.format,'idms-field-offline-owned-handoff-v1');assert.equal(fieldSha256(original),input.packSha256);
 const run=async(name,{key=true,trust='trust.json',expected=0,digest}={})=>{
  const args=['--pack',file(name),'--trust-config',file(trust),'--hmac-policy',key?'require':'optional',...(key?['--event-key-file',file('event-key.bin')]:[]),...(digest?['--expected-pack-sha256',digest]:[])],child=fork(resolve('scripts/fixtures/field-offline-evidence-probe.mjs'),args,{windowsHide:true,env:{...process.env,NODE_ENV:'test',IDMS_FIELD_EVIDENCE_QA:'1'},stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='',actions,terminal=false;
  child.stdout.on('data',b=>stdout=(stdout+b).slice(-65536));child.stderr.on('data',b=>stderr=(stderr+b).slice(-4096));child.on('message',m=>{if(m.type==='OFFLINE_ACTIONS')actions=m;});const closed=new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>{terminal=true;ok({code,signal});});}),timer=setTimeout(()=>child.kill(),45000);
  try{const result=await closed;assert.equal(result.code,expected,'Offline evidence '+name+': '+stderr);assert.equal(actions?.networkAttempts,0);assert.equal(actions?.childProcessAttempts,0);return JSON.parse(expected===0?stdout:stderr);}finally{clearTimeout(timer);if(!terminal){child.kill();await closed;}}
 };
 try{
  const verified=await run('pack.json',{digest:input.packSha256});assert.equal(verified.points,6);assert.equal(verified.receipts,6);assert.equal(verified.acknowledgements,7);assert.equal(verified.checks,2);assert.equal(verified.allEventHmacReauthenticated,true);assert.equal(verified.hmacVerifiedEvents,6);
  const publicOnly=await run('pack.json',{key:false});assert.equal(publicOnly.platformSignedSnapshotVerified,true);assert.equal(publicOnly.allEventHmacReauthenticated,false);assert.equal(publicOnly.hmacVerifiedEvents,0);assert.equal(publicOnly.currentDatabaseOrFreshnessProven,false);
  for(const name of input.malformed){const bytes=await readFile(file(name+'.json'));await run(name+'.json',{expected:1});assert.deepEqual(await readFile(file(name+'.json')),bytes);}
  const wrong=generateKeyPairSync('ed25519'),trust=JSON.parse(await readFile(file('trust.json')));await writePrivate(file('wrong-trust.json'),canonical({...trust,keys:[{keyId:fieldLeaseKeyId(wrong.publicKey),publicKeyPem:wrong.publicKey.export({type:'spki',format:'pem'})}]}));await run('pack.json',{trust:'wrong-trust.json',expected:1});await writePrivate(file('foreign-trust.json'),canonical({...trust,tenantId:'sandbox'}));await run('pack.json',{trust:'foreign-trust.json',expected:1});await run('pack.json',{digest:'0'.repeat(64),expected:1});
  const bytes=await readFile(file('event-key.bin'));try{await writeFile(file('event-key.bin'),Buffer.alloc(32,7));await run('pack.json',{expected:1});}finally{await writeFile(file('event-key.bin'),bytes);bytes.fill(0);}
  await writePrivate(file('noncanonical.json'),JSON.stringify(JSON.parse(original),null,2));await run('noncanonical.json',{expected:1});assert.deepEqual(await readFile(file('pack.json')),original);
  return {actualOfflineCliAfterAllOwnedBusinessPeersAndDatabasesClosed:true,actualNetworkAndChildProcessAttemptCountersZero:true,actualSignedSourceAndRestoredNewStreamProofRecalculated:true,actualPoints:6,actualReceipts:6,actualAcks:7,actualChecks:2,actualHistoricalHmacEvents:6,externalPinnedTrustAndExpectedPackDigestVerified:true,publicOnlyModeDoesNotClaimHmacReauthentication:true,malformedValidlyResignedAndUnsignedInputsRefused:true,malformedCaseCount:input.malformed.length+5,wrongTrustScopeDigestAndHmacKeyRefused:true,canonicalJsonRequired:true,originalPackAndMalformedInputsRetainedDuringVerification:true,allVerifierChildrenActuallyTerminal:true,noConfiguredPrivateKeyPasswordOrTokenInPublicReport:true,currentDatabaseOrFreshnessNotClaimed:true,physicalHardwareAttestationNotClaimed:true,fieldCommissioned:false,productionAcceptance:false};
 }finally{const actual=await realpath(directory),checked=relative(base,actual);assert.ok(actual===directory&&!isAbsolute(checked)&&!checked.startsWith('..')&&/^offline-evidence-[a-f0-9]{10}$/.test(checked));await rm(actual,{recursive:true,force:true});}
}
