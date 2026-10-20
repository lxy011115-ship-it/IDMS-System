import {randomBytes,createHmac} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {canonical} from '../server/imports.ts';
import {fieldSha256,publicFieldProfileDigest,freezeFieldValue} from '../integrations/field-profile.ts';
import {fieldRegistrationCandidate} from '../server/field-recovery-registration.ts';
import {PinnedFieldReadOnlyClient} from '../services/field/opcua-readonly.ts';
import {verifyFieldMaterials} from '../services/field/certificates.ts';
import {verifyFieldMqttMaterials} from '../services/field/mqtt-materials.ts';
import {readOnlyFieldServices} from '../services/field/read-protocol.ts';
import {loadActivationMaterialSet} from './field-activation-material-files.mjs';
import {inspectFieldMqttTlsPeer} from './field-activation-tls-peer.mjs';
import {activationFail as fail} from './field-activation-record.mjs';

// A root-side inspection capability. The random fingerprint secret and raw
// materials never leave it. Serialized evidence is historical data, not a
// callable runtime or machine lease, and cannot reopen this capability.
export class FieldActivationMaterialInspection {
 #configuration;#registration;#key=randomBytes(32);#evidence=null;#fingerprint=null;#started=performance.now();#wall=Date.now();#controller=new AbortController();#job=null;#closed=false;#closeJob=null;
 constructor(configuration,registration){this.#configuration=configuration;this.#registration=fieldRegistrationCandidate(registration);}
 get evidence(){if(!this.#evidence)fail('FIELD_ACTIVATION_MATERIAL_INSPECTION_REQUIRED');return structuredClone(this.#evidence);}
 #current(){if(this.#closed||this.#controller.signal.aborted)fail('FIELD_ACTIVATION_MATERIAL_INSPECTION_CLOSED');if(Date.now()<this.#wall||performance.now()-this.#started>30000||this.#evidence&&Date.now()>=this.#evidence.validUntilMs)fail('FIELD_ACTIVATION_MATERIAL_EVIDENCE_EXPIRED');}
 async inspect({assertAuthorized,signal}={}){
  if(this.#job||this.#evidence||typeof assertAuthorized!=='function')fail('FIELD_ACTIVATION_MATERIAL_INSPECTION_INVALID');this.#current();
  const timeout=AbortSignal.timeout(30000),combined=signal?AbortSignal.any([signal,this.#controller.signal,timeout]):AbortSignal.any([this.#controller.signal,timeout]);
  const job=Promise.resolve().then(async()=>{
   let loaded;const observations=[],clients=new Set();
   try{
    await assertAuthorized();this.#current();loaded=await loadActivationMaterialSet(this.#configuration,this.#registration,this.#key);const digest=loaded.fingerprint;
    const permit=expected=>p=>{this.#current();if(combined.aborted||p.profileDigest!==expected)fail('FIELD_ACTIVATION_MATERIAL_INSPECTION_REVOKED');};
    let next=0,error;const worker=async()=>{while(!error){const index=next++;if(index>=loaded.channels.length)return;const c=loaded.channels[index],profileDigest=publicFieldProfileDigest(c.profile);let client;
     try{
      this.#current();await assertAuthorized();if(combined.aborted)fail('FIELD_ACTIVATION_MATERIAL_INSPECTION_REVOKED');
      const opc=verifyFieldMaterials(c.edge.profile,c.edge.opcua),edge=verifyFieldMqttMaterials(c.profile,c.edge.mqtt.url,'EDGE',c.edge.mqtt.materials),platform=verifyFieldMqttMaterials(c.profile,c.platform.url,'PLATFORM',c.platform.materials);
      client=new PinnedFieldReadOnlyClient(c.edge.profile,c.edge.opcua,permit(profileDigest));clients.add(client);
      const read=await client.readOnce({signal:combined});await client.close();clients.delete(client);client=null;
      if(read.channel.requestServices.some(s=>!readOnlyFieldServices.includes(s))||read.profileDigest!==profileDigest||read.samples.length!==c.profile.points.length)fail('FIELD_ACTIVATION_OPCUA_SCOPE_CHANGED');
      const peers=[];for(const [role,mqtt]of [['EDGE',c.edge.mqtt],['PLATFORM',c.platform]])peers.push(await inspectFieldMqttTlsPeer(c.profile,mqtt.url,role,mqtt.materials,{signal:combined,authorize:permit(profileDigest)}));
      observations[index]={edgeId:c.edgeId,profileDigest,edgeConfigurationSha256:c.edgeConfigurationSha256,profileFileSha256:c.profileFileSha256,opcua:{serverCertificateSha256:opc.server.sha256,clientCertificateSha256:opc.client.sha256,sampleCount:read.samples.length,services:read.channel.requestServices,readObservationMac:createHmac('sha256',this.#key).update(canonical(read)).digest('hex'),writeServicesUsed:false,callServicesUsed:false},mqttTls:peers,notAfterMs:Math.min(Date.parse(opc.server.notAfter),Date.parse(opc.client.notAfter),edge.notAfter,platform.notAfter)};
     }catch(e){error??=e;this.#controller.abort();throw e;}finally{if(client){await client.close();clients.delete(client);}}
    }};
    const results=await Promise.allSettled(Array.from({length:Math.min(4,loaded.channels.length)},worker));const rejected=results.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;if(error)throw error;
    this.#current();await assertAuthorized();let current;try{current=await loadActivationMaterialSet(this.#configuration,this.#registration,this.#key);if(current.fingerprint!==digest)fail('FIELD_ACTIVATION_MATERIAL_CHANGED_DURING_INSPECTION');}finally{current?.clear();}
    this.#current();const body={format:'idms-field-activation-material-evidence-v1',tenantId:this.#registration.tenantId,operationId:this.#registration.operationId,registrationSha256:this.#registration.registrySha256,configurationSha256:loaded.configurationSha256,intakeConfigurationSha256:loaded.intakeConfigurationSha256,materialMac:digest,capturedAt:new Date().toISOString(),validUntilMs:Math.min(this.#wall+30000,...observations.map(c=>c.notAfterMs)),channels:observations.sort((a,b)=>a.edgeId<b.edgeId?-1:1),trustScope:'APPROVED_LEAF_PINS_LOCAL_REVOCATION_LISTS_MQTT_CA_NO_ONLINE_OCSP',mqttApplicationSessionsCreated:false,brokerTopicAclVerified:false,dataIngested:false,leaseIssued:false,activationGranted:false};this.#fingerprint=digest;this.#evidence={...body,sha256:fieldSha256(canonical(body))};freezeFieldValue(this.#evidence);return this.evidence;
   }finally{await Promise.allSettled([...clients].map(c=>c.close()));loaded?.clear();}
  });this.#job=job;try{return await job;}finally{if(this.#job===job)this.#job=null;}
 }
 async revalidate(){
  if(this.#job||!this.#evidence)fail('FIELD_ACTIVATION_MATERIAL_INSPECTION_REQUIRED');this.#current();let loaded;const job=Promise.resolve().then(async()=>{try{loaded=await loadActivationMaterialSet(this.#configuration,this.#registration,this.#key);this.#current();if(loaded.fingerprint!==this.#fingerprint)fail('FIELD_ACTIVATION_MATERIAL_CHANGED_BEFORE_COMMIT');return this.evidence;}finally{loaded?.clear();}});this.#job=job;try{return await job;}finally{if(this.#job===job)this.#job=null;}
 }
 async close(){if(this.#closeJob)return this.#closeJob;this.#closed=true;this.#controller.abort();this.#closeJob=Promise.resolve().then(async()=>{await this.#job?.catch(()=>{});this.#key.fill(0);});return this.#closeJob;}
}
