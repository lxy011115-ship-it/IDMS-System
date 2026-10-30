import {allColdFieldObservationsV1} from './cold-field-observation-group-v1.mjs';
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
import {loadColdFieldDeploymentMaterialFilesV4} from './cold-field-deployment-material-files-v4.mjs';
import {readActivationMaterialFile} from './field-activation-material-files.mjs';
import {verifyColdFieldPgScramV1} from './cold-field-pg-scram-v1.mjs';
import {publicFieldProfileDigest} from '../integrations/field-profile.ts';
import {PinnedFieldReadOnlyClient} from '../services/field/opcua-readonly.ts';
import {readOnlyFieldServices} from '../services/field/read-protocol.ts';
import {inspectFieldMqttTlsPeer} from './field-activation-tls-peer.mjs';

const owners=new WeakMap(),same=(a,b)=>canonical(a)===canonical(b);
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const pathValue=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&isAbsolute(value)&&resolve(value)===value&&!/[\u0000-\u001f\u007f]/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash=(key,value)=>createHmac('sha256',key).update(canonical(value)).digest('hex');
const safeError=(error,phase,elapsed)=>{const code=error?.code,reason=['COLD_FIELD_CURRENT_EXPIRED_OR_CLOSED','COLD_FIELD_CURRENT_TRANSPORT_EXPIRED','COLD_REGISTRATION_FILES_EXPIRED'].includes(code)?'EXPIRED_OR_CLOSED':['COLD_FIELD_INPUT_BYTES_CHANGED','COLD_FIELD_INPUT_IDENTITY_CHANGED','COLD_FIELD_INPUT_DIRECTORY_CHANGED','COLD_FIELD_CURRENT_FILES_CHANGED','COLD_REGISTRATION_FILES_DRIFT','COLD_FIELD_DEPLOYMENT_SOURCE_CHANGED'].includes(code)?'INPUT_CHANGED':['COLD_FIELD_CURRENT_CONTEXT_CHANGED','COLD_FIELD_CURRENT_SESSION_CHANGED','COLD_OWNED_SESSION_NOT_MINTED'].includes(code)?'CONTEXT_CHANGED':code==='COLD_FIELD_CURRENT_IDENTITY_CHANGED'?'IDENTITY_CHANGED':'UNVERIFIABLE';return Object.assign(Error('COLD_FIELD_CURRENT_UNVERIFIABLE'),{code:'COLD_FIELD_CURRENT_UNVERIFIABLE',safePhase:['CREATE','VERIFY_CURRENT','OBSERVE_TRANSPORT','REVALIDATE'].includes(phase)?phase:'CREATE',safeReason:reason,elapsedMs:Number.isFinite(elapsed)?Math.min(3600000,Math.max(0,Math.round(elapsed))):0});};
const discard=value=>{if(!value)return;for(const account of [value.host?.controlAccount,...(value.host?.tenants??[]).map(value=>value.account)])if(account)account.password='';return value.clear();};
async function json(file){const bytes=await readActivationMaterialFile(file,2*1024**2);try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}}

/** Whole FIELD files, current guarded credentials/identity and scoped transport.
 * Core catalogs/decryption, broker application ACL and startup
 * program approval remain required before a complete deployment candidate.
 */
export async function createColdFieldCurrentMaterialsV4(raw,session){
  need(exact(raw,['trust','recoveryId','configurationFile','roots','workDirectory','authority'])&&uuid(raw.recoveryId)&&pathValue(raw.configurationFile)&&pathValue(raw.workDirectory)&&Array.isArray(raw.roots)&&raw.roots.length>0&&raw.roots.length<=16&&raw.roots.every(pathValue),'COLD_FIELD_CURRENT_CONTEXT');
  // Original request-file owner must be HELD before any file, SQL or HTTP I/O.
  const held=assertColdOwnedReviewSessionBindingV1(session,{trust:raw.trust,recoveryId:raw.recoveryId}),config=structuredClone(raw),authority=authorityRuntimeV1(config.authority);
  const wall=Date.now(),monotonic=performance.now(),key=randomBytes(32),controller=new AbortController(),context={trust:config.trust,roots:config.roots,workDirectory:config.workDirectory};
  let fileSet,initial,compiled,phase='CREATE',closed=false,busy=false,active,closeJob,evidence,transportCompleted=false;
  const current=()=>{need(!closed&&!controller.signal.aborted&&Date.now()>=wall&&Date.now()<wall+30000&&performance.now()-monotonic<30000,'COLD_FIELD_CURRENT_EXPIRED_OR_CLOSED');need(same(assertColdOwnedReviewSessionBindingV1(session,{trust:config.trust,recoveryId:config.recoveryId}),held),'COLD_FIELD_CURRENT_SESSION_CHANGED');if(evidence)need(Date.now()<evidence.validUntilMs,'COLD_FIELD_CURRENT_TRANSPORT_EXPIRED');};
  try{
    current();const state=await readRuntimeColdReviewWithFieldSourceV2(config.trust),source=state.source,intent=state.details.review;
    need(state.phase==='REVIEW_READY_V3'&&intent?.recoveryId===config.recoveryId&&intent.result?.businessAdmissionGranted===false,'COLD_FIELD_CURRENT_ORIGINAL_READY');
    const inventory=coldRegistrationSourceInventoryV2(source,{sourceHash:config.trust.sourceHash,controlDirectory:dirname(config.trust.storeFile)}),binding={controlId:source.controlId,sourceHash:config.trust.sourceHash,sourceInventorySha256:inventory.sha256,recoveryId:config.recoveryId,intentSha256:held.intentSha256};
    const expected={trust:config.trust,recoveryId:config.recoveryId,source,targetDirectory:state.details.targetDirectory,credentialSha256:intent.credentialSha256};
    need(authority.trust.authorityId===source.sourceAuthority.authorityId&&authority.issuer===source.sourceAuthority.issuer,'COLD_FIELD_CURRENT_AUTHORITY');
    initial=await loadColdFieldDeploymentMaterialFilesV4(config.configurationFile,context,key);current();
    const sourceBinding=structuredClone(initial.sourceBinding),fingerprint=initial.fingerprint,sourceEvidence=structuredClone(initial.evidence);
    fileSet=createColdRegistrationFileSetV1({binding,roots:config.roots,forbiddenRoots:[source.inventory.identity.directory,state.details.targetDirectory].map(value=>resolve(value)),files:initial.privateFiles.map((value,index)=>({id:'field-current-'+String(index+1).padStart(4,'0'),purpose:'PRIVATE_BINARY',path:value.path,maximumBytes:value.bytes}))});
    const files=await fileSet.capture();compiled=initial;initial=null;
    async function unchanged(){
      current();const now=await readRuntimeColdReviewWithFieldSourceV2(config.trust);need(now.phase==='REVIEW_READY_V3'&&same(now.source,source)&&same(now.details.review,intent)&&now.details.targetDirectory===expected.targetDirectory,'COLD_FIELD_CURRENT_CONTEXT_CHANGED');await fileSet.revalidate();let loaded;
      const verified=await compiled.revalidateInputWitness();need(verified.allOriginalBytesAndIdentitiesVerified&&verified.allDirectoryEntriesVerified&&verified.originalSourceAnchorsUnchanged&&same(compiled.sourceBinding,sourceBinding)&&timingSafeEqual(Buffer.from(compiled.fingerprint,'hex'),Buffer.from(fingerprint,'hex')),'COLD_FIELD_CURRENT_FILES_CHANGED');current();
    }
    await unchanged();
    const run=(name,operation)=>{need(!busy,'COLD_FIELD_CURRENT_BUSY');current();phase=name;busy=true;const task=Promise.resolve().then(operation).catch(async error=>{closed=true;controller.abort();await fileSet.close();await discard(compiled);compiled=null;key.fill(0);throw safeError(error,name,performance.now()-monotonic);}).finally(()=>{busy=false;if(active===task)active=null;});active=task;return task;};
    const identity=async()=>{current();const head=await new IdentityAuthorityGuardV1(authority).assertCurrent();current();need(head.hash===source.sourceAuthority.hash&&head.event.authorityId===source.sourceAuthority.authorityId&&head.event.epoch===source.sourceAuthority.epoch&&head.event.issuer===source.sourceAuthority.issuer,'COLD_FIELD_CURRENT_IDENTITY_CHANGED');return {authorityId:head.event.authorityId,epoch:head.event.epoch,hash:head.hash,issuer:head.event.issuer};};
    const publicEvidence=()=>{current();need(evidence,'COLD_FIELD_CURRENT_VERIFICATION_REQUIRED');assertColdRegistrationFileSetV1(fileSet,binding);return structuredClone(evidence);};
    const api=Object.freeze({
      verifyCurrent(client){need(!evidence,'COLD_FIELD_CURRENT_ALREADY_VERIFIED');return run('VERIFY_CURRENT',async()=>{
        need(client instanceof pg.Client&&client.getTransactionStatus()==='T','COLD_FIELD_CURRENT_TRANSACTION');const [,beforePeers,beforeIdentity]=await allColdFieldObservationsV1([()=>unchanged(),()=>assertColdOwnedReviewPeersV1(client,session,expected),()=>identity()]);current();let loaded,loadedAuthority,roleRows=[];
        try{
          await compiled.revalidateInputWitness();loaded=compiled;need(loaded.fingerprint===fingerprint,'COLD_FIELD_CURRENT_FILES_CHANGED');
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
          const [afterIdentity,,afterPeers]=await allColdFieldObservationsV1([()=>identity(),()=>unchanged(),()=>assertColdOwnedReviewPeersV1(client,session,expected)]);need(same(beforeIdentity,afterIdentity),'COLD_FIELD_CURRENT_IDENTITY_CHANGED');current();
          const peer=value=>({format:value.format,readerCount:value.readerCount,guardCount:value.guardCount,evidenceSha256:value.evidenceSha256});
          const value={format:'COLD_FIELD_CURRENT_MATERIALS_V2',binding,sourceBinding,files,aggregateMaterialMac:fingerprint,capturedAt:new Date(wall).toISOString(),verifiedAt:new Date().toISOString(),validUntilMs:wall+30000,sourceFileAndSpoolEvidence:sourceEvidence,matchedAccounts:matched,identity:afterIdentity,beforePeers:peer(beforePeers),afterPeers:peer(afterPeers),originalHeldSessionVerified:true,wholePrivateFileSetAndEmptyWalRevalidated:true,currentTargetConfiguredAccountPasswordsMatched:true,currentIdentityVerified:true,additionalBusinessSqlConnectionsOpened:false,loginOrSqlPrivilegesEnabled:false,coreCatalogAndEncryptedContentsVerificationDelegated:true,actualTransportObserved:false,brokerTopicAclVerified:false,actualStartupProgramsApproved:false,completeFieldMaterialsVerified:false,completeDeploymentMaterialsVerified:false,independentApprovalGranted:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};evidence={...value,evidenceMac:hash(key,value)};return publicEvidence();
        }finally{for(const role of roleRows)role.rolpassword='';if(loadedAuthority)loadedAuthority.reader.clientSecret='';}
      });},
      observeTransport(client){
        need(evidence&&!transportCompleted,'COLD_FIELD_CURRENT_TRANSPORT_ORDER');
        return run('OBSERVE_TRANSPORT',async()=>{
          need(client instanceof pg.Client&&client.getTransactionStatus()==='T','COLD_FIELD_CURRENT_TRANSACTION');
          const [,beforePeers,beforeIdentity]=await allColdFieldObservationsV1([()=>unchanged(),()=>assertColdOwnedReviewPeersV1(client,session,expected),()=>identity()]);
          current();let loaded;const clients=new Set();
          try{
            await compiled.revalidateInputWitness();loaded=compiled;
            need(same(loaded.sourceBinding,sourceBinding)&&loaded.fingerprint===fingerprint,'COLD_FIELD_CURRENT_FILES_CHANGED');
            const channels=loaded.tenants.flatMap(tenant=>tenant.materials.channels.map(channel=>({tenantId:tenant.tenantId,channel})));
            need(channels.length===sourceEvidence.channels,'COLD_FIELD_CURRENT_TRANSPORT_COVERAGE');
            const remaining=Math.max(1,Math.floor(Math.min(wall+30000-Date.now(),30000-(performance.now()-monotonic))));
            const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(remaining)]),observations=[];
            let next=0,failure;
            const permit=digest=>value=>{current();need(!signal.aborted&&value?.profileDigest===digest,'COLD_FIELD_CURRENT_TRANSPORT_PERMIT');};
            const worker=async()=>{
              while(!failure){
                const index=next++;if(index>=channels.length)return;
                const {tenantId,channel}=channels[index],digest=publicFieldProfileDigest(channel.profile);let reader;
                try{
                  current();reader=new PinnedFieldReadOnlyClient(channel.edge.profile,channel.edge.opcua,permit(digest));clients.add(reader);
                  const read=await reader.readOnce({signal});await reader.close();clients.delete(reader);reader=null;
                  need(read.profileDigest===digest&&read.samples.length===channel.profile.points.length&&read.channel.requestServices.every(service=>readOnlyFieldServices.includes(service)),'COLD_FIELD_CURRENT_OPCUA_SCOPE');
                  const peers=[];
                  for(const [role,mqtt]of [['EDGE',channel.edge.mqtt],['PLATFORM',channel.platform]])peers.push(await inspectFieldMqttTlsPeer(channel.profile,mqtt.url,role,mqtt.materials,{signal,authorize:permit(digest)}));
                  current();observations[index]={tenantId,edgeId:channel.edgeId,profileDigest:digest,edgeConfigurationSha256:channel.edgeConfigurationSha256,profileFileSha256:channel.profileFileSha256,opcua:{sampleCount:read.samples.length,requestServiceAllowlist:read.channel.requestServices,readObservationMac:hash(key,read),writeServicesUsed:false,callServicesUsed:false},mqttTls:peers,notAfterMs:channel.notAfterMs};
                }catch(error){failure??=error;controller.abort();throw error;}
                finally{if(reader){await reader.close();clients.delete(reader);}}
              }
            };
            const results=await Promise.allSettled(Array.from({length:Math.min(4,channels.length)},worker));
            const rejected=results.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;if(failure)throw failure;
            const [,afterIdentity,afterPeers]=await allColdFieldObservationsV1([()=>unchanged(),()=>identity(),()=>assertColdOwnedReviewPeersV1(client,session,expected)]);need(same(beforeIdentity,afterIdentity),'COLD_FIELD_CURRENT_IDENTITY_CHANGED');current();
            const peer=value=>({format:value.format,readerCount:value.readerCount,guardCount:value.guardCount,evidenceSha256:value.evidenceSha256});
            const value={...evidence,transportObservedAt:new Date().toISOString(),validUntilMs:Math.min(evidence.validUntilMs,...observations.map(value=>value.notAfterMs)),transportChannels:observations.sort((a,b)=>a.tenantId.localeCompare(b.tenantId)||a.edgeId.localeCompare(b.edgeId)),transportBeforePeers:peer(beforePeers),transportAfterPeers:peer(afterPeers),transportIdentity:afterIdentity,transportInspectionComplete:true,sourceExplicitlyDisabled:!sourceBinding.siteFieldEnabled,allSourceConfiguredTenantChannelsObserved:true,actualTransportObserved:observations.length>0,privatePathsPublished:false,unkeyedPrivateDigestsPublished:false,mqttApplicationSessionsCreated:false,dataIngested:false,leaseIssued:false};
            delete value.evidenceMac;current();evidence={...value,evidenceMac:hash(key,value)};transportCompleted=true;return publicEvidence();
          }finally{await Promise.allSettled([...clients].map(client=>client.close()));}
        });
      },
      revalidate(client){return run('REVALIDATE',async()=>{need(evidence,'COLD_FIELD_CURRENT_VERIFICATION_REQUIRED');await allColdFieldObservationsV1([()=>unchanged(),()=>identity(),()=>assertColdOwnedReviewPeersV1(client,session,expected)]);current();return publicEvidence();});},
      evidence(){need(!busy,'COLD_FIELD_CURRENT_BUSY');return publicEvidence();},
      close(){closed=true;controller.abort();return closeJob??=(async()=>{await active?.catch(()=>{});await fileSet.close();await discard(compiled);compiled=null;key.fill(0);authority.reader.clientSecret='';config.authority.reader.clientSecret='';})();}
    });owners.set(api,{binding,session});return api;
  }catch(error){closed=true;controller.abort();await discard(initial);await discard(compiled);compiled=null;await fileSet?.close();key.fill(0);authority.reader.clientSecret='';config.authority.reader.clientSecret='';throw safeError(error,phase,performance.now()-monotonic);}
}
export function assertColdFieldCurrentMaterialsV4(value,binding,session){const owner=owners.get(value);need(owner&&same(owner.binding,binding)&&owner.session===session,'COLD_FIELD_CURRENT_ORIGINAL_OWNER');return value.evidence();}
