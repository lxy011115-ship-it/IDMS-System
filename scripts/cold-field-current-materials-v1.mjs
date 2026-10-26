import pg from 'pg';
import {randomBytes,timingSafeEqual,createHmac} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {resolve,dirname,isAbsolute} from 'node:path';
import {canonical} from '../server/imports.ts';
import {authorityRuntimeV1,IdentityAuthorityGuardV1} from '../server/identity-authority-live-v1.ts';
import {readRuntimeColdReviewWithFieldSourceV2} from './runtime-cold-readonly-control-v7.mjs';
import {assertColdOwnedReviewSessionBindingV1,assertColdOwnedReviewPeersV1} from './cold-owned-review-session-v3-request-file-v1.mjs';
import {coldRegistrationSourceInventoryV2} from './cold-registration-source-inventory-v2.mjs';
import {createColdRegistrationFileSetV1,assertColdRegistrationFileSetV1} from './cold-registration-file-set-v1.mjs';
import {loadColdFieldDeploymentMaterialFilesV3} from './cold-field-deployment-material-files-v3.mjs';
import {readActivationMaterialFile} from './field-activation-material-files.mjs';
import {verifyColdFieldPgScramV1} from './cold-field-pg-scram-v1.mjs';

const owners=new WeakMap(),same=(a,b)=>canonical(a)===canonical(b);
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const pathValue=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&isAbsolute(value)&&resolve(value)===value&&!/[\u0000-\u001f\u007f]/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash=(key,value)=>createHmac('sha256',key).update(canonical(value)).digest('hex');
const safeError=()=>Object.assign(Error('COLD_FIELD_CURRENT_UNVERIFIABLE'),{code:'COLD_FIELD_CURRENT_UNVERIFIABLE'});
const discard=value=>{if(!value)return;for(const account of [value.host?.controlAccount,...(value.host?.tenants??[]).map(value=>value.account)])if(account)account.password='';value.clear();};
async function json(file){const bytes=await readActivationMaterialFile(file,2*1024**2);try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}}

/** Whole FIELD files plus current guarded target credentials and identity only.
 * Core catalogs/decryption, actual transport, broker application ACL and startup
 * program approval remain required before a complete deployment candidate.
 */
export async function createColdFieldCurrentMaterialsV1(raw,session){
  need(exact(raw,['trust','recoveryId','configurationFile','roots','workDirectory','authority'])&&uuid(raw.recoveryId)&&pathValue(raw.configurationFile)&&pathValue(raw.workDirectory)&&Array.isArray(raw.roots)&&raw.roots.length>0&&raw.roots.length<=16&&raw.roots.every(pathValue),'COLD_FIELD_CURRENT_CONTEXT');
  // Original request-file owner must be HELD before any file, SQL or HTTP I/O.
  const held=assertColdOwnedReviewSessionBindingV1(session,{trust:raw.trust,recoveryId:raw.recoveryId}),config=structuredClone(raw),authority=authorityRuntimeV1(config.authority);
  const wall=Date.now(),monotonic=performance.now(),key=randomBytes(32),context={trust:config.trust,roots:config.roots,workDirectory:config.workDirectory};
  let fileSet,initial,closed=false,busy=false,active,closeJob,evidence;
  const current=()=>{need(!closed&&Date.now()>=wall&&Date.now()<wall+30000&&performance.now()-monotonic<30000,'COLD_FIELD_CURRENT_EXPIRED_OR_CLOSED');need(same(assertColdOwnedReviewSessionBindingV1(session,{trust:config.trust,recoveryId:config.recoveryId}),held),'COLD_FIELD_CURRENT_SESSION_CHANGED');};
  try{
    current();const state=await readRuntimeColdReviewWithFieldSourceV2(config.trust),source=state.source,intent=state.details.review;
    need(state.phase==='REVIEW_READY_V3'&&intent?.recoveryId===config.recoveryId&&intent.result?.businessAdmissionGranted===false,'COLD_FIELD_CURRENT_ORIGINAL_READY');
    const inventory=coldRegistrationSourceInventoryV2(source,{sourceHash:config.trust.sourceHash,controlDirectory:dirname(config.trust.storeFile)}),binding={controlId:source.controlId,sourceHash:config.trust.sourceHash,sourceInventorySha256:inventory.sha256,recoveryId:config.recoveryId,intentSha256:held.intentSha256};
    const expected={trust:config.trust,recoveryId:config.recoveryId,source,targetDirectory:state.details.targetDirectory,credentialSha256:intent.credentialSha256};
    need(authority.trust.authorityId===source.sourceAuthority.authorityId&&authority.issuer===source.sourceAuthority.issuer,'COLD_FIELD_CURRENT_AUTHORITY');
    initial=await loadColdFieldDeploymentMaterialFilesV3(config.configurationFile,context,key);current();
    const sourceBinding=structuredClone(initial.sourceBinding),fingerprint=initial.fingerprint,sourceEvidence=structuredClone(initial.evidence);
    fileSet=createColdRegistrationFileSetV1({binding,roots:config.roots,forbiddenRoots:[source.inventory.identity.directory,state.details.targetDirectory].map(value=>resolve(value)),files:initial.privateFiles.map((value,index)=>({id:'field-current-'+String(index+1).padStart(4,'0'),purpose:'PRIVATE_BINARY',path:value.path,maximumBytes:value.bytes}))});
    const files=await fileSet.capture();discard(initial);initial=null;
    async function unchanged(){
      current();const now=await readRuntimeColdReviewWithFieldSourceV2(config.trust);need(now.phase==='REVIEW_READY_V3'&&same(now.source,source)&&same(now.details.review,intent)&&now.details.targetDirectory===expected.targetDirectory,'COLD_FIELD_CURRENT_CONTEXT_CHANGED');await fileSet.revalidate();let loaded;
      try{loaded=await loadColdFieldDeploymentMaterialFilesV3(config.configurationFile,context,key);need(same(loaded.sourceBinding,sourceBinding)&&timingSafeEqual(Buffer.from(loaded.fingerprint,'hex'),Buffer.from(fingerprint,'hex')),'COLD_FIELD_CURRENT_FILES_CHANGED');current();}finally{discard(loaded);}
    }
    await unchanged();
    const run=operation=>{need(!busy,'COLD_FIELD_CURRENT_BUSY');current();busy=true;const task=Promise.resolve().then(operation).catch(async()=>{closed=true;await fileSet.close();key.fill(0);throw safeError();}).finally(()=>{busy=false;if(active===task)active=null;});active=task;return task;};
    const identity=async()=>{current();const head=await new IdentityAuthorityGuardV1(authority).assertCurrent();current();need(head.hash===source.sourceAuthority.hash&&head.event.authorityId===source.sourceAuthority.authorityId&&head.event.epoch===source.sourceAuthority.epoch&&head.event.issuer===source.sourceAuthority.issuer,'COLD_FIELD_CURRENT_IDENTITY_CHANGED');return {authorityId:head.event.authorityId,epoch:head.event.epoch,hash:head.hash,issuer:head.event.issuer};};
    const publicEvidence=()=>{current();need(evidence,'COLD_FIELD_CURRENT_VERIFICATION_REQUIRED');assertColdRegistrationFileSetV1(fileSet,binding);return structuredClone(evidence);};
    const api=Object.freeze({
      verifyCurrent(client){need(!evidence,'COLD_FIELD_CURRENT_ALREADY_VERIFIED');return run(async()=>{
        need(client instanceof pg.Client&&client.getTransactionStatus()==='T','COLD_FIELD_CURRENT_TRANSACTION');await unchanged();
        const beforePeers=await assertColdOwnedReviewPeersV1(client,session,expected),beforeIdentity=await identity();current();let loaded,loadedAuthority,roleRows=[];
        try{
          loaded=await loadColdFieldDeploymentMaterialFilesV3(config.configurationFile,context,key);need(loaded.fingerprint===fingerprint,'COLD_FIELD_CURRENT_FILES_CHANGED');
          const target=(await client.query("SELECT (pg_control_system()).system_identifier::text AS system_id,current_setting('data_directory') AS directory,session_user::regrole::oid::text AS control_oid,current_user::regrole::oid::text AS current_oid,host(inet_server_addr()) AS host,inet_server_port() AS port,session_user AS role_name")).rows[0];
          need(target&&target.system_id===source.inventory.identity.system_id&&resolve(target.directory)===resolve(expected.targetDirectory)&&target.control_oid===source.inventory.identity.control_oid&&target.current_oid===target.control_oid&&target.host==='127.0.0.1','COLD_FIELD_CURRENT_TARGET');
          const accounts=[];
          if(loaded.sourceBinding.siteFieldEnabled){
            const descriptor=await json(config.configurationFile),gatewayFile=resolve(dirname(descriptor.siteRuntimeFile),loaded.site.field.gatewayFile),hostFile=resolve(dirname(gatewayFile),loaded.gateway.authorityHostFile),trustFile=resolve(dirname(hostFile),loaded.host.coldTrustFile),authorityFile=resolve(dirname(hostFile),loaded.host.authorityRuntimeFile);
            need(same(await json(trustFile),config.trust),'COLD_FIELD_CURRENT_HOST_TRUST');loadedAuthority=authorityRuntimeV1(await json(authorityFile));need(same(loadedAuthority,authority),'COLD_FIELD_CURRENT_HOST_AUTHORITY');
            need(loaded.host.controlAccount.host===target.host&&loaded.host.controlAccount.port===target.port&&loaded.host.controlAccount.database==='postgres'&&loaded.host.controlAccount.user===target.role_name,'COLD_FIELD_CURRENT_CONTROL_ACCOUNT');accounts.push({tenantId:null,roleOid:target.control_oid,databaseOid:null,account:loaded.host.controlAccount});
            for(const tenant of loaded.host.tenants){
              const map=source.fullFacts.databases.find(value=>value.map?.tenantId===tenant.tenantId),role=source.inventory.roles.find(value=>value.oid===tenant.binding.roleOid),gate=source.active.find(value=>value.databaseOid===tenant.binding.databaseOid),database=source.inventory.databases.find(value=>value.oid===tenant.binding.databaseOid);
              need(map&&role&&gate&&database&&same(tenant.binding,map.map.profile.binding)&&gate.actorOids.includes(role.oid)&&role.rolname===tenant.account.user&&database.datname===tenant.account.database&&tenant.account.host===target.host&&tenant.account.port===target.port,'COLD_FIELD_CURRENT_TENANT_ACCOUNT');accounts.push({tenantId:tenant.tenantId,roleOid:role.oid,databaseOid:database.oid,account:tenant.account});
            }
          }
          roleRows=(await client.query('SELECT oid::text,rolname,rolpassword FROM pg_authid WHERE oid=ANY($1::oid[]) ORDER BY oid',[accounts.map(value=>value.roleOid)])).rows;need(roleRows.length===accounts.length,'COLD_FIELD_CURRENT_ROLE_COVERAGE');
          const matched=[];for(const item of accounts){current();const role=roleRows.find(value=>value.oid===item.roleOid&&value.rolname===item.account.user);need(role,'COLD_FIELD_CURRENT_ROLE');try{const proof=await verifyColdFieldPgScramV1(item.account.password,role.rolpassword);matched.push({tenantId:item.tenantId,roleOid:item.roleOid,databaseOid:item.databaseOid,...proof});}finally{role.rolpassword='';}current();}
          for(const role of roleRows)role.rolpassword='';
          const afterIdentity=await identity();need(same(beforeIdentity,afterIdentity),'COLD_FIELD_CURRENT_IDENTITY_CHANGED');await unchanged();const afterPeers=await assertColdOwnedReviewPeersV1(client,session,expected);current();
          const peer=value=>({format:value.format,readerCount:value.readerCount,guardCount:value.guardCount,evidenceSha256:value.evidenceSha256});
          const value={format:'COLD_FIELD_CURRENT_MATERIALS_V1',binding,sourceBinding,files,aggregateMaterialMac:fingerprint,capturedAt:new Date(wall).toISOString(),verifiedAt:new Date().toISOString(),validUntilMs:wall+30000,sourceFileAndSpoolEvidence:sourceEvidence,matchedAccounts:matched,identity:afterIdentity,beforePeers:peer(beforePeers),afterPeers:peer(afterPeers),originalHeldSessionVerified:true,wholePrivateFileSetAndEmptyWalRevalidated:true,currentTargetConfiguredAccountPasswordsMatched:true,currentIdentityVerified:true,additionalBusinessSqlConnectionsOpened:false,loginOrSqlPrivilegesEnabled:false,coreCatalogAndEncryptedContentsVerificationDelegated:true,actualTransportObserved:false,brokerTopicAclVerified:false,actualStartupProgramsApproved:false,completeFieldMaterialsVerified:false,completeDeploymentMaterialsVerified:false,independentApprovalGranted:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};evidence={...value,evidenceMac:hash(key,value)};return publicEvidence();
        }finally{for(const role of roleRows)role.rolpassword='';if(loadedAuthority)loadedAuthority.reader.clientSecret='';discard(loaded);}
      });},
      revalidate(client){return run(async()=>{need(evidence,'COLD_FIELD_CURRENT_VERIFICATION_REQUIRED');await unchanged();await identity();await assertColdOwnedReviewPeersV1(client,session,expected);current();return publicEvidence();});},
      evidence(){need(!busy,'COLD_FIELD_CURRENT_BUSY');return publicEvidence();},
      close(){closed=true;return closeJob??=(async()=>{await active?.catch(()=>{});await fileSet.close();key.fill(0);authority.reader.clientSecret='';config.authority.reader.clientSecret='';})();}
    });owners.set(api,{binding,session});return api;
  }catch{closed=true;discard(initial);await fileSet?.close();key.fill(0);authority.reader.clientSecret='';config.authority.reader.clientSecret='';throw safeError();}
}
export function assertColdFieldCurrentMaterialsV1(value,binding,session){const owner=owners.get(value);need(owner&&same(owner.binding,binding)&&owner.session===session,'COLD_FIELD_CURRENT_ORIGINAL_OWNER');return value.evidence();}
