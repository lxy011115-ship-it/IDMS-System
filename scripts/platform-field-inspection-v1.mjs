import {resolve,dirname} from 'node:path';
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {readApplicationFileV1} from './runtime-application-config-v1.mjs';
import {fieldMapAuthorityGatewayConfigV1} from './field-map-authority-gateway-v1.mjs';
import {fieldMapAuthorityHostConfigV1} from './field-map-authority-host-v1.mjs';
import {fieldRegistrationCandidate} from '../server/field-recovery-registration.ts';
import {loadFieldPlatformConfig,clearFieldPlatformConfig} from '../server/field-config.ts';
import {assertFieldRecoveryDatabase,assertFieldRecoveryRegistry} from '../server/field-recovery-read.ts';
import {inspectMqttBrokerRuntimeV1} from './mqtt-broker-runtime-v1.mjs';
import {loadActivationMaterialSet,readActivationMaterialFile} from './field-activation-material-files.mjs';

const need=(v,c)=>{if(!v)throw Error(c);},normal=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p),same=(a,b)=>normal(a)===normal(b);
const code=e=>/^PLATFORM_[A-Z0-9_]+$/.test(e?.message??'')?e.message:'PLATFORM_FIELD_MATERIALS_UNVERIFIABLE';
const decode=b=>JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(b).replace(/^\uFEFF/,''));

/** Exact declared transports and material sets. This does not grant recovery activation. */
export async function inspectPlatformFieldFilesV1(config,app,manifestFile){
 need(config.field.enabled===true&&app.field.enabled===true,'PLATFORM_FIELD_DISABLED');
 const key=randomBytes(32),pins=new Map(),registrations=new Map();let fingerprint=null,closed=false,stage='SITE_ENTRY';
 async function json(file){const item=await readApplicationFileV1(file);if(pins.has(item.path))need(pins.get(item.path)===item.sha256,'PLATFORM_FIELD_INPUT_CHANGED');else pins.set(item.path,item.sha256);return{...item,value:decode(item.bytes)};}
 async function inspect(){
  need(!closed,'PLATFORM_FIELD_INSPECTION_CLOSED');stage='SITE_ENTRY';const mac=createHmac('sha256',key),brokers=new Map(),loaded=[];let platform;
  const include=(label,value)=>{mac.update(canonical({label,value})+'\n');};
  try{
   const site=app.components.find(c=>c.kind==='SITE'),wrapper=await json(resolve(dirname(manifestFile),site.runtimeFile)),cold=await json(resolve(dirname(wrapper.path),wrapper.value.baseRuntimeFile));
   need(cold.value.format===1&&cold.value.purpose==='RUNTIME_COLD_SITE_V1','PLATFORM_FIELD_SITE_COLD_ENTRY');
   const authority=await json(resolve(dirname(cold.path),cold.value.baseRuntimeFile));need(authority.value.format===1&&authority.value.purpose==='SITE_CONSOLE_AUTHORITY_V1','PLATFORM_FIELD_SITE_AUTHORITY_ENTRY');
   let baseSite=await json(resolve(dirname(authority.path),authority.value.baseRuntimeFile));const siteFiles=new Set();
   while(baseSite.value.purpose!=='SITE_CONSOLE_HTTP'){need(siteFiles.size<8&&!siteFiles.has(normal(baseSite.path))&&['SITE_CONSOLE_HTTP_R4','SITE_CONSOLE_HTTP_R3'].includes(baseSite.value.purpose)&&baseSite.value.format===({'SITE_CONSOLE_HTTP_R4':4,'SITE_CONSOLE_HTTP_R3':3}[baseSite.value.purpose])&&typeof baseSite.value.baseSiteRuntimeFile==='string','PLATFORM_FIELD_SITE_LISTENER');siteFiles.add(normal(baseSite.path));baseSite=await json(resolve(dirname(baseSite.path),baseSite.value.baseSiteRuntimeFile));}
   need(baseSite.value.format===1&&baseSite.value.host==='127.0.0.1'&&Number.isInteger(baseSite.value.port)&&baseSite.value.port>1024&&baseSite.value.port<=65535,'PLATFORM_FIELD_SITE_LISTENER');
   stage='GATEWAY_HOST';const gatewayFile=resolve(dirname(wrapper.path),wrapper.value.field.gatewayFile),gateway=fieldMapAuthorityGatewayConfigV1((await json(gatewayFile)).value);need(gateway.enabled,'PLATFORM_FIELD_GATEWAY_DISABLED');
   const hostFile=resolve(dirname(gatewayFile),gateway.authorityHostFile),host=fieldMapAuthorityHostConfigV1((await json(hostFile)).value),platformFile=resolve(dirname(gatewayFile),gateway.platformFile),platformJson=await json(platformFile),intake=await json(resolve(dirname(gatewayFile),gateway.intakeFile));
   need(same(resolve(dirname(hostFile),host.coldTrustFile),resolve(dirname(cold.path),cold.value.trustFile))&&same(resolve(dirname(cold.path),cold.value.trustFile),resolve(dirname(manifestFile),app.trustFile))&&same(resolve(dirname(hostFile),host.authorityRuntimeFile),resolve(dirname(authority.path),authority.value.authorityRuntimeFile)),'PLATFORM_FIELD_SITE_BINDING');
   const siteAuthority=await json(resolve(dirname(authority.path),authority.value.authorityRuntimeFile)),managerAuthority=await json(resolve(dirname(manifestFile),app.authorityRuntimeFile));need(siteAuthority.sha256===managerAuthority.sha256,'PLATFORM_FIELD_AUTHORITY_BINDING');
   const database=config.postgres.find(p=>p.port===host.controlAccount.port);need(database&&host.controlAccount.host==='127.0.0.1'&&host.controlAccount.user===database.account.user&&host.controlAccount.password===database.account.password,'PLATFORM_FIELD_CONTROL_ENDPOINT');
   need(host.tenants.every(t=>app.tenantIds.includes(t.tenantId)),'PLATFORM_FIELD_TENANT');
   stage='PLATFORM_CONFIG';need(platformJson.value.format==='idms-field-platform-config-v2','PLATFORM_FIELD_PLATFORM_FENCED');platform=await loadFieldPlatformConfig(platformFile);need(platform.tenants.size===host.tenants.length&&host.tenants.every(t=>platform.tenants.get(t.tenantId)?.channels.size>0),'PLATFORM_FIELD_TENANT_COVERAGE');
   for(const t of host.tenants){const p=platform.tenants.get(t.tenantId);need(p.recovery,'PLATFORM_FIELD_RECOVERY_REQUIRED');assertFieldRecoveryDatabase(p.recovery,{host:t.account.host,port:t.account.port,database:t.account.database,user:t.account.user});assertFieldRecoveryRegistry(p.recovery,p.snapshot);}
   need(intake.value.format==='idms-field-platform-intake-v1'&&Array.isArray(intake.value.tenants)&&intake.value.tenants.length===platform.tenants.size,'PLATFORM_FIELD_INTAKE_COVERAGE');
   stage='BROKER_MATERIALS';for(const b of config.field.brokers){const inspected=await inspectMqttBrokerRuntimeV1(b.runtimeFile);loaded.push(inspected);need(inspected.config.port===b.port&&inspected.config.host==='127.0.0.1','PLATFORM_FIELD_BROKER_ENDPOINT');const declared=config.field.edges.filter(e=>e.brokerId===b.id).map(e=>e.tenantId+'/'+e.edgeId).sort(),actual=inspected.config.channels.map(c=>c.tenantId+'/'+c.edgeId).sort();need(canonical(actual)===canonical(declared),'PLATFORM_FIELD_BROKER_ACL_COVERAGE');brokers.set(b.id,inspected);include('broker:'+b.id,[...inspected.pins].sort((a,b)=>a.path.localeCompare(b.path)));}
   const materialSets=new Map(),owned=new Set();
   stage='EDGE_MATERIALS';for(const e of config.field.edges){
    need(app.tenantIds.includes(e.tenantId),'PLATFORM_FIELD_EDGE_TENANT');const registration=fieldRegistrationCandidate((await json(e.registrationFile)).value),tenant=platform.tenants.get(e.tenantId);need(registration.tenantId===e.tenantId&&tenant&&registration.configSha256===platformJson.sha256&&canonical(registration.registry)===canonical(tenant.snapshot),'PLATFORM_FIELD_REGISTRATION_BINDING');
    const group=normal(e.configurationFile)+'\0'+normal(e.registrationFile);let material=materialSets.get(group);if(!material){material=await loadActivationMaterialSet(e.configurationFile,registration,key);materialSets.set(group,material);loaded.push(material);include('materials:'+group,material.fingerprint);}
    const selected=material.channels.filter(c=>c.edgeId===e.edgeId);need(selected.length===1,'PLATFORM_FIELD_EDGE_MATERIAL');
    const declaredMaterial=await json(e.configurationFile),declaredEdge=declaredMaterial.value.edges?.filter(c=>c.edgeId===e.edgeId);need(declaredEdge?.length===1&&same(declaredEdge[0].configurationFile,e.edgeConfigurationFile),'PLATFORM_FIELD_EDGE_CONFIGURATION');
    const c=selected[0],b=brokers.get(e.brokerId),transport=c.profile.transport;need(c.edge.lease.url==='http://127.0.0.1:'+new URL(c.edge.lease.url).port+'/api/v1/field-channel/lease','PLATFORM_FIELD_EDGE_LEASE_ORIGIN');
    need(new URL(c.edge.lease.url).port===String(baseSite.value.port),'PLATFORM_FIELD_SITE_LISTENER');
    need(c.edge.mqtt.url==='mqtts://127.0.0.1:'+b.config.port&&c.platform.url===c.edge.mqtt.url&&transport.serverCertificateSha256===b.materialBinding.serverCertificateSha256&&transport.caCertificateSha256===b.materialBinding.caCertificateSha256,'PLATFORM_FIELD_TRANSPORT_BINDING');
    const channels=intake.value.tenants.filter(t=>t.tenantId===e.tenantId);need(channels.length===1&&Array.isArray(channels[0].channels),'PLATFORM_FIELD_INTAKE_TENANT');const actualChannel=channels[0].channels.filter(x=>x.edgeId===e.edgeId);need(actualChannel.length===1&&actualChannel[0].mqtt?.url===c.platform.url,'PLATFORM_FIELD_INTAKE_CHANNEL');
    for(const [name,property]of [['caFile','caCertificate'],['serverCertificateFile','serverCertificate'],['clientCertificateFile','clientCertificate'],['privateKeyFile','privateKeyPem']]){const bytes=await readActivationMaterialFile(resolve(dirname(intake.path),actualChannel[0].mqtt[name]),65536);try{need(bytes.equals(c.platform.materials[property]),'PLATFORM_FIELD_INTAKE_MATERIAL');mac.update(bytes);}finally{bytes.fill(0);}}
    need(!owned.has(e.tenantId+'/'+e.edgeId),'PLATFORM_FIELD_EDGE_DUPLICATE');owned.add(e.tenantId+'/'+e.edgeId);registrations.set(e.id,registration);include('edge:'+e.id,{configurationSha256:c.edgeConfigurationSha256,profile:c.profile});
   }
   let total=0;for(const [tenantId,t]of platform.tenants){include('recovery:'+tenantId,t.recovery?.control);for(const [edgeId,c]of t.channels){total++;need(owned.has(tenantId+'/'+edgeId),'PLATFORM_FIELD_EDGE_COVERAGE');mac.update(c.requestKey);need(c.eventKey,'PLATFORM_FIELD_EVENT_KEY');mac.update(c.eventKey);}}
   need(total===config.field.edges.length&&intake.value.tenants.every(t=>Array.isArray(t.channels)&&t.channels.length===[...owned].filter(k=>k.startsWith(t.tenantId+'/')).length),'PLATFORM_FIELD_EDGE_COVERAGE');
   for(const [path,digest]of pins){need((await readApplicationFileV1(path)).sha256===digest,'PLATFORM_FIELD_INPUT_CHANGED');include(path,digest);}return mac.digest('hex');
  }finally{if(platform)clearFieldPlatformConfig(platform);for(const item of loaded){item.clear?.();for(const b of Object.values(item.materials??{}))if(Buffer.isBuffer(b))b.fill(0);}}
 }
 const api={get pins(){return[...pins].map(([path,sha256])=>({path,sha256}));},registration(id){need(!closed&&registrations.has(id),'PLATFORM_FIELD_REGISTRATION_UNKNOWN');return structuredClone(registrations.get(id));},async assertCurrent(){try{need(timingSafeEqual(Buffer.from(await inspect(),'hex'),Buffer.from(fingerprint,'hex')),'PLATFORM_FIELD_MATERIALS_CHANGED');}catch(e){throw Object.assign(Error(code(e)),{stage,causeCode:/^FIELD_[A-Z0-9_]+$/.test(e?.code??e?.message)?(e.code??e.message):null,errorKind:['Error','TypeError','RangeError','DomainError','FieldChannelError'].includes(e?.name)?e.name:'UNKNOWN'});}},clear(){closed=true;key.fill(0);registrations.clear();}};
 try{fingerprint=await inspect();return Object.freeze(api);}catch(e){api.clear();throw Object.assign(Error(code(e)),{stage,causeCode:/^FIELD_[A-Z0-9_]+$/.test(e?.code??e?.message)?(e.code??e.message):null,errorKind:['Error','TypeError','RangeError','DomainError','FieldChannelError'].includes(e?.name)?e.name:'UNKNOWN'});}
}
