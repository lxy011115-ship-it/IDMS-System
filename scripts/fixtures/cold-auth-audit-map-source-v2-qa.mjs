import {loadAuthAuditRuntimeV4} from '../../server/auth-audit-runtime-v4.ts';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {seedColdReviewConsistentBusinessQaV1} from './cold-review-consistent-business-v1-qa.mjs';
import {loadAuthoritySiteRuntimeV1} from '../../server/identity-authority-entry-v1.ts';
import {authorityJsonV1} from '../../server/identity-authority-live-v1.ts';
import {AuthAuditSourceV4} from '../../server/auth-audit-source-v4.ts';
import {AuthAuditCryptoV4} from '../../server/auth-audit-event-v4.ts';
import {AuthAuditMapV4Writer} from '../../server/auth-audit-map-v4.ts';
import {DomainMapV4} from '../../server/domain-map-v4.ts';
import {appendAudit} from '../../server/audit.ts';
import {auditPositionKey,verifyLocalDomainAudit} from '../../server/telemetry-map-v4.ts';
import {opaqueId} from '../../server/auth-state.ts';
import {observeOwnedForkTerminalV1} from '../owned-fork-terminal-v1.mjs';

/** Historical-format QA evidence uses the ordinary APP delta transaction and real audit chain. */
async function appendHistoricalAndOrdinaryQa(target,identity){
 const map=new DomainMapV4(target.account,target.binding),snapshot=await map.snapshot();
 try{
  const head=await snapshot.get('domain_head','audit'),previous=head.eventId?verifyLocalDomainAudit(await snapshot.get('audit',head.eventId),identity.tenantId):null;
  assert(previous?previous.hash===head.hash:head.hash==='GENESIS');
  const window={audits:previous?[previous]:[]},operations=[],events=[];let position=BigInt(head.count);
  for(const input of [
   {objectType:'AUTHENTICATION',objectId:identity.actorId,action:'AUTH_LOGIN',metadata:{authMode:'oidc',roles:identity.roles}},
   {objectType:'COLD_RECOVERY_QA',objectId:'auth-map-source',action:'SOURCE_PREPARATION_RECORDED',metadata:{historicalFormatQa:true}}
  ]){
   const event=appendAudit(window,{...input,tenantId:identity.tenantId,actorType:'USER',actorId:identity.actorId,correlationId:randomUUID()});
   verifyLocalDomainAudit(event,identity.tenantId);position++;
   operations.push(await snapshot.operation('audit',event.eventId,event),await snapshot.operation('audit_order',auditPositionKey(String(position)),{tenantId:identity.tenantId,position:String(position),eventId:event.eventId}));events.push(event);
  }
  const last=events.at(-1);operations.push(await snapshot.operation('domain_head','audit',{tenantId:identity.tenantId,count:String(position),eventId:last.eventId,hash:last.hash}));
  await map.commit(snapshot.head,randomUUID(),operations);
  return{historicalAuditEventId:events[0].eventId,ordinaryAuditEventId:events[1].eventId,historicalFormatSeedOnly:true,actualV3BrowserLoginClaimed:false};
 }finally{await snapshot.close();}
}

/** Seed before write-fence sealing/closing. No raw event insertion, status update or synthetic ACK. */
export async function seedColdAuthAuditMapSourceQaV2(o){
 const cases=await seedColdReviewConsistentBusinessQaV1(o),{site,identity,work,save}=o;
 const participants=JSON.parse(await readFile(join(work,'consistent-source-participants.private.json'),'utf8'));
 const bindings=site.qa.bindings(site.auth),targetBindings=new Map(Object.entries(site.qa.targets).map(([tenant,t])=>[tenant,t.binding]));
 const source=new AuthAuditSourceV4(site.qa.deliveryAccount,bindings.delivery,new AuthAuditCryptoV4(site.qa.auditRing,bindings.delivery),targetBindings);
 const runtime=await loadAuthoritySiteRuntimeV1(site.siteFile),tenants={};
 const derivedKeyFile=await save('auth-map-source-derived-key.private.json',site.qa.auditRing);
 try{
  for(const tenant of ['acme','sandbox']){
   const user=participants[tenant].author,tokens=await authorityJsonV1(identity.runtime.issuer+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:site.auth.clientId,username:user.username,password:user.password,scope:'openid'})});
   const checked=await runtime.base.auth.verify(tokens.access_token);assert.equal(checked.identity.actorId,user.id);assert.equal(checked.identity.tenantId,tenant);assert.equal(checked.identity.authMode,'oidc');
   const sid=opaqueId();await runtime.base.state.createSession(sid,{...checked,tokens,createdAt:Date.now(),csrf:opaqueId()});
   const first=await source.claim(tenant);assert(first);const login=source.open(first);assert.equal(login.header.position,'1');assert.equal(login.header.action,'AUTH_LOGIN');
   const target=site.qa.targets[tenant],writer=new AuthAuditMapV4Writer(target.account,target.binding,bindings.delivery);
   const proof=await writer.deliver(login);await source.acknowledge(first,proof);const delivered=await source.delivery(first.header.eventId);assert.equal(delivered.status,'DELIVERED');
   const historical=await appendHistoricalAndOrdinaryQa(target,checked.identity);
   await runtime.base.state.explicitLogout(()=>runtime.base.state.withSession(sid,async()=>({remove:true,value:true})));
   const tailSid=opaqueId();await runtime.base.state.createSession(tailSid,{...checked,tokens,createdAt:Date.now(),csrf:opaqueId()});
   const childFile=await save('auth-map-source-'+tenant+'-delivery.private.json',{format:1,purpose:'AUTH_AUDIT_DELIVERY_RUNTIME',keyFile:derivedKeyFile,source:{account:site.qa.deliveryAccount,binding:bindings.delivery},targets:[{account:target.account,binding:target.binding}]});
   await loadAuthAuditRuntimeV4(childFile);
   const child=fork('scripts/fixtures/auth-audit-recovery-child-v4.mjs',[childFile],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
   const terminal=observeOwnedForkTerminalV1(child);let claim=null,bytes=0;const output={stdout:[],stderr:[]};
   for(const [name,stream]of [['stdout',child.stdout],['stderr',child.stderr]])stream.on('data',b=>{bytes+=b.length;if(bytes<=1024*1024)output[name].push(Buffer.from(b));});
   child.on('message',message=>{if(message?.type==='BUSINESS_COMMITTED_BEFORE_SOURCE_ACK'){assert.equal(claim,null);claim=message.claim;}});
   const observed=await terminal;await save('auth-map-source-'+tenant+'-child-terminal.private.json',{pid:child.pid,terminal:observed,stdout:Buffer.concat(output.stdout).toString('utf8'),stderr:Buffer.concat(output.stderr).toString('utf8'),bytes});assert.deepEqual(observed,{code:0,signal:null});assert(bytes<1024*1024);assert(claim);assert.equal(claim.header.tenantId,tenant);assert.equal(claim.header.position,'2');assert.equal(claim.header.action,'AUTH_LOGOUT');
   const awaiting=await source.delivery(claim.header.eventId);assert.equal(awaiting.status,'RUNNING');assert.equal(awaiting.receipt,null);assert.equal(awaiting.fence,claim.fence);
   // No claim/renew/defer/ACK after this point: the original RUNNING row and lease survive capture.
   const committed=await writer.deliver(source.open(claim));assert.equal(committed.value.completion.sourceEventId,claim.header.eventId);
   tenants[tenant]={...historical,deliveredEventId:first.header.eventId,unacknowledgedEventId:claim.header.eventId,sourceDelivered:delivered,sourceAwaiting:awaiting,originalClaim:claim,child:{pid:child.pid,terminal:await terminal,actualChildExitedAfterBusinessCommit:true},businessReceipt:committed.value};
  }
  await save('auth-map-source-seed.private.json',{format:'COLD_AUTH_AUDIT_MAP_SOURCE_SEED_V1',binding:bindings.delivery,tenants,actualOidcIdentitiesVerified:true,originalSourceRowsNeverRewritten:true,actualV3BrowserLoginClaimed:false});
  return cases;
 }finally{await runtime.close();}
}
