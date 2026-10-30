import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,readdir,unlink,rmdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createPrivateKey} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {canonical} from '../server/imports.ts';
import {openAuthoritySqliteV1,appendAuthorityEventSqliteV1} from '../server/identity-authority-store-v1.ts';
import {createIdentityAuthorityControlV1,beginIdentityAuthorityTransitionV1} from '../scripts/identity-authority-control-v1.mjs';
import {createColdCurrentDeploymentReviewContractV1,closeColdCurrentDeploymentReviewInitializationV1,currentDeploymentReviewPurposeV1} from '../scripts/cold-current-deployment-review-contract-v1.mjs';
import {createColdCurrentDeploymentUserIntentGateV1,currentDeploymentUserActionV1} from '../scripts/cold-current-deployment-user-intent-v1.mjs';
import {reviewSourceHashV1 as hash} from '../scripts/workflow-review-source-facts-v1.mjs';
import {privateDirectory} from '../scripts/backup-support.mjs';

const inputFile=process.env.IDMS_CURRENT_DEPLOYMENT_USER_FIXTURE,work=process.env.IDMS_CURRENT_DEPLOYMENT_USER_WORK;assert(inputFile&&work&&resolve(inputFile)===inputFile&&resolve(work)===work);
const historical=JSON.parse(await readFile(inputFile,'utf8'));assert.equal(historical.fixtureIsHistoricalSourceDataOnly,true);
const keys=await generateKeyPair('RS256'),jwk={...await exportJWK(keys.publicKey),kid:'owned-protocol-test',use:'sig',alg:'RS256'};
async function fixture(){
  const directory=join(work,'protocol-'+randomUUID());await mkdir(directory);await privateDirectory(directory);
  const control=await createIdentityAuthorityControlV1(join(directory,'authority'));
  let issuer,head,gate,created;const users=new Map(),requests=[],state={revoked:false,changed:false,reads:0,wrongMarker:false};
  const loginClientUuid=randomUUID(),readerSecret='protocol-reader-'+randomUUID();
  const server=createServer(async(req,res)=>{try{
    const url=req.url,parts=[];for await(const chunk of req)parts.push(chunk);
    requests.push({method:req.method,path:url});res.setHeader('content-type','application/json');res.setHeader('connection','close');
    if(url==='/realms/idms/protocol/openid-connect/certs'){res.end(JSON.stringify({keys:[jwk]}));return;}
    if(url==='/realms/idms/protocol/openid-connect/token'){
      const params=new URLSearchParams(Buffer.concat(parts).toString());assert.equal(params.get('grant_type'),'client_credentials');assert.equal(params.get('client_secret'),readerSecret);res.end(JSON.stringify({access_token:'owned-fixture-service-reader',token_type:'Bearer',expires_in:300}));return;}
    assert.equal(req.headers.authorization,'Bearer owned-fixture-service-reader');
    if(url==='/admin/realms/idms'){res.end(JSON.stringify({id:'protocol-realm',realm:'idms',enabled:true,notBefore:0,attributes:{idms_authority_id:control.trust.authorityId,idms_authority_epoch:'1',idms_authority_challenge:state.wrongMarker?'wrong':head.event.challenge}}));return;}
    if(url==='/admin/realms/idms/clients/'+loginClientUuid){res.end(JSON.stringify({id:loginClientUuid,clientId:'idms-review',enabled:true,notBefore:0}));return;}
    const match=/^\/admin\/realms\/idms\/users\/([^/]+)(.*)$/.exec(url),u=match&&users.get(match[1]);assert(u);
    if(match[2]===''){state.reads++;res.end(JSON.stringify({id:u.id,username:u.username,enabled:!state.revoked,requiredActions:[],notBefore:0,attributes:{tenant_id:[u.tenant],idms_sites:['*'],idms_lines:['*'],idms_devices:['*']}}));return;}
    if(match[2]==='/role-mappings/realm/composite'){res.end(JSON.stringify([{name:state.changed&&state.reads>users.size?'auditor':'tenant-admin'}]));return;}
    if(match[2]==='/sessions'){res.end(JSON.stringify(state.revoked?[]:[{id:u.sid,userId:u.id,start:u.started,clients:{[loginClientUuid]:'idms-review'}}]));return;}
    throw Error('UNEXPECTED_PROTOCOL_PATH');
  }catch{res.statusCode=500;res.end('{}');}});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));issuer='http://127.0.0.1:'+server.address().port+'/realms/idms';
  try{
    const operationId=randomUUID(),transition=await beginIdentityAuthorityTransitionV1(control,{expectedRevision:0,operationId,issuer,realmId:'protocol-realm',binding:{host:'127.0.0.1',port:50001,systemIdentifier:'1234567890123456789',database:'identity_protocol',databaseOid:'16384',role:'identity_protocol',roleOid:'16385'},evidenceSha256:'1'.repeat(64)});
    // Protocol fixture only: this signed log does not claim a real Keycloak/PG activation.
    const privateKey=createPrivateKey(JSON.parse(await readFile(control.keyFile,'utf8')).privateKey),db=await openAuthoritySqliteV1(control.trust,true);
    try{db.exec('BEGIN IMMEDIATE');head=appendAuthorityEventSqliteV1(db,control.trust,privateKey,{...transition.event,revision:2,phase:'ACTIVE',previousHash:transition.hash,at:new Date().toISOString()},1);db.exec('COMMIT');}finally{db.close();}
    const context=structuredClone(historical.context);context.source.sourceAuthority={authorityId:control.trust.authorityId,epoch:1,hash:head.hash,issuer};context.trust.sourceHash=hash(context.source);context.originalReview.sourceHash=context.trust.sourceHash;
    created=createColdCurrentDeploymentReviewContractV1(context,{purpose:currentDeploymentReviewPurposeV1,reviewId:randomUUID(),operationId:randomUUID(),expectedSourceHash:context.trust.sourceHash,expectedOriginalIntentSha256:hash(context.originalReview),expectedOriginalResultSha256:hash(context.originalReview.result),expectedDeploymentSha256:context.deploymentSha256,expectedProgramInventorySha256:context.programInventorySha256});
    const participants=[],confirmations=[];
    for(const tenantId of context.source.fullFacts.databases.filter(d=>d.map).map(d=>d.map.tenantId).sort()){
      const reader=created.privateRecord.readerCredentials.readers.find(v=>v.tenantId===tenantId),id=randomUUID(),sid=randomUUID(),iat=Math.floor(Date.now()/1000),u={id,sid,tenant:tenantId,username:'protocol-'+tenantId,started:iat*1000};users.set(id,u);
      const accessToken=await new SignJWT({typ:'Bearer',azp:'idms-review',tenant_id:tenantId,preferred_username:u.username,sid,realm_access:{roles:['tenant-admin']},idms_sites:['*'],idms_lines:['*'],idms_devices:['*']}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setAudience('idms-api').setSubject(id).setIssuedAt(iat).setExpirationTime(iat+300).sign(keys.privateKey);
      participants.push({format:'idms-field-recovery-external-config-v1',tenantId,auth:{mode:'oidc',issuer,audience:'idms-api',clientId:'idms-review',origin:'http://127.0.0.1:4011'},identityReader:{clientId:'owned-identity-reader',clientSecret:readerSecret,loginClientUuid},workflow:{baseUrl:'http://127.0.0.1:50002',recoveryReadToken:reader.token,authorityId:reader.authorityId,definitionSha256:reader.bpmnSha256}});
      confirmations.push({tenantId,confirmationId:randomUUID(),confirmedAt:new Date().toISOString(),action:currentDeploymentUserActionV1,expectedSourceHash:context.trust.sourceHash,expectedFullFactsSha256:context.source.fullFacts.sha256,expectedDeploymentSha256:context.deploymentSha256,expectedProgramInventorySha256:context.programInventorySha256,accessToken});
    }
    const config={context,privateRecord:created.privateRecord,expectedIntentSha256:created.privateRecord.intent.sha256,authority:{format:1,purpose:'IDENTITY_AUTHORITY_RUNTIME_V1',trust:control.trust,issuer,reader:{clientId:'owned-authority-reader',clientSecret:readerSecret}},participants};
    gate=createColdCurrentDeploymentUserIntentGateV1(config);
    return{gate,config,state,requests,request:{purpose:currentDeploymentReviewPurposeV1,reviewId:created.privateRecord.intent.body.reviewId,operationId:created.privateRecord.intent.body.operationId,expectedIntentSha256:created.privateRecord.intent.sha256,confirmations},async close(){await gate.close();closeColdCurrentDeploymentReviewInitializationV1(created.initialization);await new Promise((ok,fail)=>server.close(e=>e?fail(e):ok()));const sub=join(directory,'authority');const names=await readdir(sub);assert(names.every(n=>['writer-key.private.json','trust.json','authority.sqlite','authority.sqlite-wal','authority.sqlite-shm'].includes(n)));for(const name of names)await unlink(join(sub,name));await rmdir(sub);assert.deepEqual(await readdir(directory),[]);await rmdir(directory);}};
  }catch(error){await new Promise(ok=>server.close(ok));throw error;}
}
async function using(run){const f=await fixture();try{return await run(f);}finally{await f.close();}}

test('two tenants explicitly confirm and actual signed HTTP identity reads mint a branded short-lived handle',()=>using(async f=>{
  const h=await f.gate.authorize(f.request),proof=f.gate.inspect(h);assert.equal(proof.actualCurrentUsersAuthenticated,true);assert.equal(proof.allSourceTenantsExplicitlyRequested,true);assert.equal(proof.confirmations.length,2);assert(proof.confirmations.every(v=>v.actor.purpose==='AUTHOR'&&v.actor.actorId&&v.actor.sessionId));assert.equal(proof.intentSha256,f.request.expectedIntentSha256);
  for(const key of ['durableConsentRecorded','ownedRuntimeSessionMinted','allCurrentTargetFactsRechecked','programStartupGranted','mqttApplicationProbeGranted','independentApprovalGranted','businessWritesEnabled','formalFieldActivationGranted','fullGoalComplete'])assert.equal(proof[key],false);
  assert.equal(JSON.stringify(proof).includes(f.request.confirmations[0].accessToken),false);assert.deepEqual(await f.gate.revalidate(h),proof);assert(Date.parse(proof.expiresAt)-Date.parse(proof.capturedAt)<=30000);assert(f.requests.filter(v=>v.path.endsWith('/sessions')).length>=6);
}));
for(const kind of ['OLD_PURPOSE','MISSING_TENANT','DUPLICATE_TENANT','FORGED_ACTOR','NO_ACTION','OLD_CONFIRMATION','FUTURE_CONFIRMATION','WRONG_DIGEST','DUPLICATE_ID','BLANK_TOKEN'])test('rejects '+kind+' before any identity request',()=>using(async f=>{
  const r=structuredClone(f.request);if(kind==='OLD_PURPOSE')r.purpose='RESTORE_ORIGINAL_SYSTEM_READ_ONLY_SUBMISSION';if(kind==='MISSING_TENANT')r.confirmations.pop();if(kind==='DUPLICATE_TENANT')r.confirmations[1].tenantId=r.confirmations[0].tenantId;if(kind==='FORGED_ACTOR')r.confirmations[0].actor={approved:true};if(kind==='NO_ACTION')r.confirmations[0].action='READ';if(kind==='OLD_CONFIRMATION')r.confirmations[0].confirmedAt=new Date(Date.now()-121000).toISOString();if(kind==='FUTURE_CONFIRMATION')r.confirmations[0].confirmedAt=new Date(Date.now()+6000).toISOString();if(kind==='WRONG_DIGEST')r.confirmations[0].expectedProgramInventorySha256='0'.repeat(64);if(kind==='DUPLICATE_ID')r.confirmations[1].confirmationId=r.confirmations[0].confirmationId;if(kind==='BLANK_TOKEN')r.confirmations[0].accessToken='';
  await assert.rejects(async()=>f.gate.authorize(r),/CURRENT_DEPLOYMENT_USER_/);assert.deepEqual(f.requests,[]);
}));
test('rejects a token from another tenant even though that token has a valid signature',()=>using(async f=>{f.request.confirmations[0].accessToken=f.request.confirmations[1].accessToken;await assert.rejects(f.gate.authorize(f.request),/FIELD_RECOVERY_ACTOR_INVALID/);}));
test('rejects current user revocation during initial authorization and permanently consumes the gate',()=>using(async f=>{f.state.revoked=true;await assert.rejects(f.gate.authorize(f.request),/FIELD_RECOVERY_ACTOR_/);f.state.revoked=false;await assert.rejects(f.gate.authorize(f.request),/CURRENT_DEPLOYMENT_USER_GATE_CLOSED/);}));
test('rejects a current role removed between the first and second identity reads',()=>using(async f=>{f.state.changed=true;await assert.rejects(f.gate.authorize(f.request),/FIELD_RECOVERY_ACTOR_/);}));
test('rejects a changed current authority marker before user authentication',()=>using(async f=>{f.state.wrongMarker=true;await assert.rejects(f.gate.authorize(f.request),/AUTHORITY_ENDPOINT_MISMATCH/);assert.equal(f.requests.some(v=>v.path.includes('/users/')),false);}));
test('a minted handle cannot survive actual current user session revocation',()=>using(async f=>{const h=await f.gate.authorize(f.request);f.state.revoked=true;await assert.rejects(f.gate.revalidate(h),/FIELD_RECOVERY_ACTOR_/);assert.throws(()=>f.gate.inspect(h),/CURRENT_DEPLOYMENT_USER_GATE_CLOSED/);}));
test('copied handles and public proof cannot authenticate and a successful gate cannot be reused',()=>using(async f=>{const h=await f.gate.authorize(f.request);for(const v of [{...h},JSON.parse(JSON.stringify(h)),f.gate.inspect(h)])assert.throws(()=>f.gate.inspect(v),/CURRENT_DEPLOYMENT_USER_HANDLE_NOT_MINTED/);await assert.rejects(f.gate.authorize(f.request),/CURRENT_DEPLOYMENT_USER_GATE_CONSUMED/);}));
test('closing waits for original identities and invalidates all handles without modifying caller credentials',()=>using(async f=>{const original=canonical(f.config.privateRecord),h=await f.gate.authorize(f.request),a=f.gate.close(),b=f.gate.close();assert.strictEqual(a,b);const closed=await a;assert(closed.allOwnedIdentityClientsClosed);assert.equal(closed.ownedTargetSqlClients,0);assert.equal(closed.ownedRuntimePrograms,0);assert.equal(canonical(f.config.privateRecord),original);assert.throws(()=>f.gate.inspect(h),/CURRENT_DEPLOYMENT_USER_GATE_CLOSED/);}));
