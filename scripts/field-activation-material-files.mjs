import {lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,isAbsolute} from 'node:path';
import {createHmac} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {fieldRegistrationCandidate} from '../server/field-recovery-registration.ts';
import {fieldSha256,fieldObject,fieldText} from '../integrations/field-profile.ts';
import {loadFieldEdgeConfiguration,clearFieldEdgeConfiguration,fieldEdgeDirectoryName} from '../services/field/edge-config.ts';
import {parseFieldProfile} from '../services/field/profile.ts';
import {readBoundedFieldFile} from '../services/field/profile.ts';
import {verifyFieldMqttMaterials} from '../services/field/mqtt-materials.ts';
import {fieldLeaseKeyId} from '../integrations/field-lease.ts';
import {activationFail as fail} from './field-activation-record.mjs';
const same=(a,b)=>canonical(a)===canonical(b),decode=b=>JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(b));
export async function readActivationMaterialFile(path,maximum){
 if(typeof path!=='string'||!isAbsolute(path))fail('FIELD_ACTIVATION_MATERIAL_PATH_INVALID');path=resolve(path);
 for(let p=path;;p=dirname(p)){const s=await lstat(p);if(s.isSymbolicLink())fail('FIELD_ACTIVATION_MATERIAL_PATH_INVALID');if(dirname(p)===p)break;}
 const before=await lstat(path,{bigint:true}),actual=await realpath(path);if(!before.isFile()||before.nlink!==1n||(process.platform==='win32'?actual.toLowerCase()!==path.toLowerCase():actual!==path))fail('FIELD_ACTIVATION_MATERIAL_PATH_INVALID');
 const bytes=await readBoundedFieldFile(path,maximum),after=await lstat(path,{bigint:true});if(before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||after.nlink!==1n){bytes.fill(0);fail('FIELD_ACTIVATION_MATERIAL_FILE_CHANGED');}return bytes;
}
// Each load owns all secret buffers. No key/password digest is exported. The
// fingerprint is keyed by a fresh per-inspection secret, unrelated to request
// keys or potentially guessable source passwords.
export async function loadActivationMaterialSet(configuration,rawRegistration,fingerprintKey){
 const registration=fieldRegistrationCandidate(rawRegistration),inventory=new Map(),aliases=new Map(),channels=[];let total=0;
 const read=async(path,max)=>{if(typeof path!=='string'||!isAbsolute(path))fail('FIELD_ACTIVATION_MATERIAL_PATH_INVALID');path=resolve(path);if(inventory.has(path))return inventory.get(path);const alias=process.platform==='win32'?path.toLowerCase():path;if(aliases.has(alias)&&aliases.get(alias)!==path)fail('FIELD_ACTIVATION_MATERIAL_PATH_ALIAS');aliases.set(alias,path);const bytes=await readActivationMaterialFile(path,max);total+=bytes.length;if(total>32*1024**2){bytes.fill(0);fail('FIELD_ACTIVATION_MATERIAL_SET_LIMIT');}inventory.set(path,bytes);return bytes;};
 const referenced=async(root,name,max=65536)=>read(resolve(root,fieldEdgeDirectoryName(name)),max);
 const clear=()=>{for(const c of channels){clearFieldEdgeConfiguration(c.edge);c.platform.materials.privateKeyPem.fill(0);}for(const bytes of inventory.values())bytes.fill(0);};
 try{
  if(!Buffer.isBuffer(fingerprintKey)||fingerprintKey.length!==32)fail('FIELD_ACTIVATION_MATERIAL_FINGERPRINT_KEY_REQUIRED');
  const configurationBytes=await read(configuration,262144),r=fieldObject(decode(configurationBytes),['format','tenantId','intakeConfigurationFile','edges']);
  if(r.format!=='idms-field-activation-materials-v1'||r.tenantId!==registration.tenantId||!Array.isArray(r.edges)||r.edges.length!==registration.registry.channels.length)fail('FIELD_ACTIVATION_MATERIAL_CONFIGURATION_INVALID');
  const intakeBytes=await read(fieldText(r.intakeConfigurationFile,4096),2097152),intake=fieldObject(decode(intakeBytes),['format','tenants']);if(intake.format!=='idms-field-platform-intake-v1'||!Array.isArray(intake.tenants)||intake.tenants.length!==1)fail('FIELD_ACTIVATION_MATERIAL_INTAKE_INVALID');
  const tenant=fieldObject(intake.tenants[0],['tenantId','channels']);if(tenant.tenantId!==registration.tenantId||!Array.isArray(tenant.channels)||tenant.channels.length!==r.edges.length)fail('FIELD_ACTIVATION_MATERIAL_INTAKE_INVALID');
  const seen=new Set(),usedConfigs=new Set(),secrets=new Set();
  for(const raw of r.edges){
   const entry=fieldObject(raw,['edgeId','configurationFile']),edgeId=fieldText(entry.edgeId,80),declared=registration.registry.channels.find(c=>c.profile.source.edgeId===edgeId),path=fieldText(entry.configurationFile,4096);if(!declared||seen.has(edgeId)||usedConfigs.has(path))fail('FIELD_ACTIVATION_MATERIAL_CHANNEL_BINDING_CHANGED');seen.add(edgeId);usedConfigs.add(path);
   const edgeBytes=await read(path,262144),edgeRaw=fieldObject(decode(edgeBytes),['format','profileFile','lease','eventKeyFile','mqtt','spool','schedule']),root=dirname(path),profileBytes=await referenced(root,edgeRaw.profileFile,131072),profile=parseFieldProfile(decode(profileBytes));
   const pair=tenant.channels.filter(c=>c?.edgeId===edgeId);if(pair.length!==1)fail('FIELD_ACTIVATION_MATERIAL_INTAKE_INVALID');const platformRaw=fieldObject(pair[0],['edgeId','mqtt']),mqtt=fieldObject(platformRaw.mqtt,['url','caFile','serverCertificateFile','clientCertificateFile','privateKeyFile']);
   const loadedPaths=[];for(const [owner,names]of [[root,[...Object.values(profile.certificates),edgeRaw.lease?.requestKeyFile,edgeRaw.lease?.platformPublicKeyFile,edgeRaw.eventKeyFile,...['caFile','serverCertificateFile','clientCertificateFile','privateKeyFile'].map(k=>edgeRaw.mqtt?.[k]),...(profile.userIdentity.type==='UserName'?[profile.userIdentity.passwordFile]:[])]],[dirname(r.intakeConfigurationFile),['caFile','serverCertificateFile','clientCertificateFile','privateKeyFile'].map(k=>mqtt[k])]])for(const name of names){fieldText(name,256);await referenced(owner,name,name===edgeRaw.eventKeyFile||name===edgeRaw.lease?.requestKeyFile?32:65536);loadedPaths.push(resolve(owner,name));}
   const edge=await loadFieldEdgeConfiguration(path);let platform;
   try{
    if(!same(edge.publicProfile,declared.profile)||fieldSha256(edge.lease.requestKey)!==declared.requestKeySha256||fieldLeaseKeyId(edge.lease.publicKey)!==registration.registry.leaseKeyId)fail('FIELD_ACTIVATION_MATERIAL_CHANNEL_BINDING_CHANGED');
    for(const secret of [edge.lease.requestKey,edge.eventKey]){const digest=fieldSha256(secret);if(secrets.has(digest))fail('FIELD_ACTIVATION_MATERIAL_KEY_REUSED');secrets.add(digest);}
    const buffers=[['serverFile',edge.opcua.serverCertificate],['clientFile',edge.opcua.clientCertificate],['privateKeyFile',edge.opcua.privateKeyPem]];for(const [name,bytes]of buffers)if(!bytes.equals(inventory.get(resolve(root,profile.certificates[name]))))fail('FIELD_ACTIVATION_MATERIAL_FILE_CHANGED');
    if(profile.userIdentity.type==='UserName'&&edge.opcua.password!==new TextDecoder('utf8',{fatal:true}).decode(inventory.get(resolve(root,profile.userIdentity.passwordFile))))fail('FIELD_ACTIVATION_MATERIAL_FILE_CHANGED');
    for(const [name,bytes]of [['requestKeyFile',edge.lease.requestKey],['eventKeyFile',edge.eventKey]]){const file=name==='requestKeyFile'?edgeRaw.lease[name]:edgeRaw[name];if(!bytes.equals(inventory.get(resolve(root,file))))fail('FIELD_ACTIVATION_MATERIAL_FILE_CHANGED');}
    platform={url:fieldText(mqtt.url,2048),materials:{caCertificate:Buffer.from(inventory.get(resolve(dirname(r.intakeConfigurationFile),mqtt.caFile))),serverCertificate:Buffer.from(inventory.get(resolve(dirname(r.intakeConfigurationFile),mqtt.serverCertificateFile))),clientCertificate:Buffer.from(inventory.get(resolve(dirname(r.intakeConfigurationFile),mqtt.clientCertificateFile))),privateKeyPem:Buffer.from(inventory.get(resolve(dirname(r.intakeConfigurationFile),mqtt.privateKeyFile)))}};
    const checked=verifyFieldMqttMaterials(declared.profile,platform.url,'PLATFORM',platform.materials);channels.push({edgeId,edge,platform,platformExpiry:checked.notAfter,profile:declared.profile,edgeConfigurationSha256:fieldSha256(edgeBytes),profileFileSha256:fieldSha256(profileBytes)});
   }catch(e){clearFieldEdgeConfiguration(edge);platform?.materials.privateKeyPem.fill(0);throw e;}
  }
  const h=createHmac('sha256',fingerprintKey);for(const [path,bytes]of [...inventory].sort(([a],[b])=>a<b?-1:a>b?1:0)){h.update(canonical({path,bytes:bytes.length})+'\n');h.update(bytes);h.update('\n');}
  // Loaded copies must also remain part of the opaque fingerprint, so a
  // concurrent change-and-revert cannot substitute a different credential.
  for(const c of [...channels].sort((a,b)=>a.edgeId<b.edgeId?-1:1)){h.update(canonical({edgeId:c.edgeId})+'\n');for(const b of [c.edge.opcua.privateKeyPem,c.edge.lease.requestKey,c.edge.eventKey,c.edge.mqtt.materials.privateKeyPem,c.platform.materials.privateKeyPem]){h.update(String(b.length)+':');h.update(b);}const password=Buffer.from(c.edge.opcua.password??'','utf8');try{h.update(String(password.length)+':');h.update(password);}finally{password.fill(0);}}
  return {registration,channels,configurationSha256:fieldSha256(configurationBytes),intakeConfigurationSha256:fieldSha256(intakeBytes),fingerprint:h.digest('hex'),clear};
 }catch(e){clear();throw e;}
}
