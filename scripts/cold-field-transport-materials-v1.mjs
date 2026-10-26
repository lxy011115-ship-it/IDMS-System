import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {resolve,dirname,isAbsolute} from 'node:path';
import {canonical} from '../server/imports.ts';
import {publicFieldProfileDigest,fieldSha256} from '../integrations/field-profile.ts';
import {PinnedFieldReadOnlyClient} from '../services/field/opcua-readonly.ts';
import {readOnlyFieldServices} from '../services/field/read-protocol.ts';
import {readRuntimeColdReviewWithFieldSourceV2} from './runtime-cold-readonly-control-v7.mjs';
import {assertColdOwnedReviewSessionBindingV1,assertColdOwnedReviewPeersV1} from './cold-owned-review-session-v3.mjs';
import {coldRegistrationSourceInventoryV2} from './cold-registration-source-inventory-v2.mjs';
import {createColdRegistrationFileSetV1,assertColdRegistrationFileSetV1} from './cold-registration-file-set-v1.mjs';
import {loadColdFieldSourceMaterialSetV1} from './cold-field-material-source-files-v1.mjs';
import {inspectFieldMqttTlsPeer} from './field-activation-tls-peer.mjs';

const owners=new WeakMap();
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const same=(a,b)=>canonical(a)===canonical(b);
const hash=value=>fieldSha256(canonical(value));
const pathValue=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&isAbsolute(value)&&value===resolve(value)&&!/[\u0000-\u001f\u007f]/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const safeError=error=>{
  const code=typeof error?.code==='string'&&/^(?:COLD_(?:FIELD|OWNED|REGISTRATION)|FIELD_ACTIVATION)_[A-Z0-9_]+$/.test(error.code)?error.code:'COLD_FIELD_TRANSPORT_UNVERIFIABLE';
  return Object.assign(Error(code),{code});
};

/**
 * A scoped transport inspection within an original HELD cold review.
 * This is not a complete FIELD deployment compiler or an admission capability.
 * In particular, signer, broker application ACL, spool and program coverage
 * still belong to the complete deployment coordinator.
 */
export async function createColdFieldTransportMaterialsV1(raw,session){
  need(exact(raw,['trust','recoveryId','tenantId','configurationFile','roots'])&&uuid(raw.recoveryId)&&typeof raw.tenantId==='string'&&raw.tenantId.length>0&&raw.tenantId.length<=80&&pathValue(raw.configurationFile)&&Array.isArray(raw.roots)&&raw.roots.length>0&&raw.roots.length<=16&&raw.roots.every(pathValue),'COLD_FIELD_TRANSPORT_CONFIG');
  // Reject copied, serialized, legacy or caller-declared owners before I/O.
  const config=structuredClone(raw);
  const held=assertColdOwnedReviewSessionBindingV1(session,{trust:config.trust,recoveryId:config.recoveryId});
  const wall=Date.now(),monotonic=performance.now(),key=randomBytes(32),controller=new AbortController();
  let fileSet,initial,evidence,closed=false,busy=false,job=null,closeJob=null;
  const current=()=>{
    need(!closed&&!controller.signal.aborted,'COLD_FIELD_TRANSPORT_CLOSED');
    need(Date.now()>=wall&&Date.now()<wall+30000&&performance.now()-monotonic<30000,'COLD_FIELD_TRANSPORT_EXPIRED');
    const actual=assertColdOwnedReviewSessionBindingV1(session,{trust:config.trust,recoveryId:config.recoveryId});
    need(same(actual,held),'COLD_FIELD_TRANSPORT_HELD_BINDING_CHANGED');
    if(evidence)need(Date.now()<evidence.validUntilMs,'COLD_FIELD_TRANSPORT_EXPIRED');
  };
  const context={trust:config.trust,tenantId:config.tenantId,roots:config.roots};
  try{
    current();
    const state=await readRuntimeColdReviewWithFieldSourceV2(config.trust),intent=state.details.review;
    need(state.phase==='REVIEW_READY_V3'&&intent?.recoveryId===config.recoveryId&&intent.result?.businessAdmissionGranted===false&&hash(intent)===held.intentSha256,'COLD_FIELD_TRANSPORT_ORIGINAL_READY');
    const inventory=coldRegistrationSourceInventoryV2(state.source,{sourceHash:config.trust.sourceHash,controlDirectory:dirname(config.trust.storeFile)});
    const binding={controlId:state.source.controlId,sourceHash:config.trust.sourceHash,sourceInventorySha256:inventory.sha256,recoveryId:config.recoveryId,intentSha256:held.intentSha256};
    const expected={trust:config.trust,recoveryId:config.recoveryId,source:state.source,targetDirectory:state.details.targetDirectory,credentialSha256:intent.credentialSha256};
    initial=await loadColdFieldSourceMaterialSetV1(config.configurationFile,context,key);
    current();
    const sourceBinding=structuredClone(initial.sourceBinding),fingerprint=initial.fingerprint;
    fileSet=createColdRegistrationFileSetV1({binding,roots:config.roots,forbiddenRoots:[state.source.inventory.identity.directory,state.details.targetDirectory].map(value=>resolve(value)),files:initial.privateFiles.map((file,index)=>({id:'field-transport-file-'+String(index+1).padStart(3,'0'),purpose:'PRIVATE_BINARY',path:file.path,maximumBytes:file.bytes}))});
    const files=await fileSet.capture();
    initial.clear();initial=null;
    async function unchanged(){
      current();
      const now=await readRuntimeColdReviewWithFieldSourceV2(config.trust);
      need(now.phase==='REVIEW_READY_V3'&&same(now.source,state.source)&&hash(now.details.review)===held.intentSha256&&now.details.targetDirectory===expected.targetDirectory,'COLD_FIELD_TRANSPORT_CONTEXT_CHANGED');
      await fileSet.revalidate();
      let loaded;
      try{
        loaded=await loadColdFieldSourceMaterialSetV1(config.configurationFile,context,key);
        need(same(loaded.sourceBinding,sourceBinding)&&timingSafeEqual(Buffer.from(loaded.fingerprint,'hex'),Buffer.from(fingerprint,'hex')),'COLD_FIELD_TRANSPORT_MATERIAL_CHANGED');
        current();
      }finally{loaded?.clear();}
    }
    await unchanged();
    const drain=async()=>{closed=true;controller.abort();await job?.catch(()=>{});await fileSet?.close();key.fill(0);};
    const run=operation=>{
      need(!busy,'COLD_FIELD_TRANSPORT_BUSY');current();busy=true;
      const task=Promise.resolve().then(operation).catch(async error=>{closed=true;controller.abort();await fileSet.close();key.fill(0);throw safeError(error);}).finally(()=>{busy=false;if(job===task)job=null;});
      job=task;return task;
    };
    const publicEvidence=()=>{current();need(evidence,'COLD_FIELD_TRANSPORT_OBSERVATION_REQUIRED');assertColdRegistrationFileSetV1(fileSet,binding);return structuredClone(evidence);};
    const api=Object.freeze({
      observe(client){
        need(!evidence,'COLD_FIELD_TRANSPORT_ALREADY_OBSERVED');
        return run(async()=>{
          let loaded;const clients=new Set();
          try{
            await unchanged();
            const before=await assertColdOwnedReviewPeersV1(client,session,expected);
            current();
            loaded=await loadColdFieldSourceMaterialSetV1(config.configurationFile,context,key);
            need(same(loaded.sourceBinding,sourceBinding)&&loaded.fingerprint===fingerprint,'COLD_FIELD_TRANSPORT_MATERIAL_CHANGED');
            const remaining=Math.max(1,Math.floor(Math.min(wall+30000-Date.now(),30000-(performance.now()-monotonic))));
            const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(remaining)]),observations=[];
            let next=0,failure;
            const permit=digest=>value=>{current();need(!signal.aborted&&value?.profileDigest===digest,'COLD_FIELD_TRANSPORT_PERMIT_REVOKED');};
            const worker=async()=>{
              while(!failure){
                const index=next++;if(index>=loaded.channels.length)return;
                const channel=loaded.channels[index],digest=publicFieldProfileDigest(channel.profile);let reader;
                try{
                  current();
                  reader=new PinnedFieldReadOnlyClient(channel.edge.profile,channel.edge.opcua,permit(digest));clients.add(reader);
                  const read=await reader.readOnce({signal});await reader.close();clients.delete(reader);reader=null;
                  need(read.profileDigest===digest&&read.samples.length===channel.profile.points.length&&read.channel.requestServices.every(service=>readOnlyFieldServices.includes(service)),'COLD_FIELD_TRANSPORT_OPCUA_SCOPE_CHANGED');
                  const peers=[];
                  for(const [role,mqtt]of [['EDGE',channel.edge.mqtt],['PLATFORM',channel.platform]])peers.push(await inspectFieldMqttTlsPeer(channel.profile,mqtt.url,role,mqtt.materials,{signal,authorize:permit(digest)}));
                  current();
                  observations[index]={edgeId:channel.edgeId,profileDigest:digest,edgeConfigurationSha256:channel.edgeConfigurationSha256,profileFileSha256:channel.profileFileSha256,opcua:{sampleCount:read.samples.length,services:read.channel.requestServices,readObservationMac:createHmac('sha256',key).update(canonical(read)).digest('hex'),writeServicesUsed:false,callServicesUsed:false},mqttTls:peers,notAfterMs:channel.notAfterMs};
                }catch(error){failure??=error;controller.abort();throw error;}finally{if(reader){await reader.close();clients.delete(reader);}}
              }
            };
            const results=await Promise.allSettled(Array.from({length:Math.min(4,loaded.channels.length)},worker));
            const rejected=results.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;if(failure)throw failure;
            await unchanged();
            const after=await assertColdOwnedReviewPeersV1(client,session,expected);
            current();
            const value={format:'COLD_FIELD_TRANSPORT_MATERIALS_V1',binding,sourceBinding,files,materialMac:files.materialMac,capturedAt:new Date(wall).toISOString(),observedAt:new Date().toISOString(),validUntilMs:Math.min(wall+30000,...observations.map(value=>value.notAfterMs)),channels:observations.sort((a,b)=>a.edgeId.localeCompare(b.edgeId)),beforePeers:before,afterPeers:after,originalHeldSessionBound:true,originalPeersReverifiedBeforeAndAfter:true,allSourceConfiguredTenantChannelsObserved:true,actualTransportObserved:true,privatePathsPublished:false,unkeyedPrivateDigestsPublished:false,mqttApplicationSessionsCreated:false,brokerTopicAclVerified:false,dataIngested:false,leaseIssued:false,completeFieldMaterialsVerified:false,completeDeploymentMaterialsVerified:false,independentApprovalGranted:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};
            // Original peer evidence contains private evidence paths. Keep the
            // public shape to its authenticated digest and exact fixed counts.
            for(const name of ['beforePeers','afterPeers']){const peer=value[name];value[name]={format:peer.format,recoveryId:peer.recoveryId,intentSha256:peer.intentSha256,readerCount:peer.readerCount,guardCount:peer.guardCount,evidenceSha256:peer.evidenceSha256};}
            evidence={...value,sha256:hash(value)};
            return publicEvidence();
          }finally{await Promise.allSettled([...clients].map(client=>client.close()));loaded?.clear();}
        });
      },
      revalidate(client){return run(async()=>{need(evidence,'COLD_FIELD_TRANSPORT_OBSERVATION_REQUIRED');await unchanged();await assertColdOwnedReviewPeersV1(client,session,expected);current();return publicEvidence();});},
      evidence(){need(!busy,'COLD_FIELD_TRANSPORT_BUSY');return publicEvidence();},
      close(){return closeJob??=drain();}
    });
    owners.set(api,{binding,session});return api;
  }catch(error){closed=true;controller.abort();initial?.clear();await fileSet?.close();key.fill(0);throw safeError(error);}
}

export function assertColdFieldTransportMaterialsV1(value,binding,session){
  const owner=owners.get(value);
  need(owner&&owner.session===session&&same(owner.binding,binding),'COLD_FIELD_TRANSPORT_OWNER');
  return value.evidence();
}
