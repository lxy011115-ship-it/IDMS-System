import {publicFieldProfileDigest} from '../integrations/field-profile.ts';
import {readColdFieldSourceHistoryV2} from './cold-field-source-history-v2.mjs';
import {inspectColdFieldSourceSpoolV2} from './cold-field-source-spool-v2.mjs';
import {coldFieldSourceStreamBindingV1} from './cold-field-source-stream-binding-v1.mjs';
import {resolve,dirname,relative,isAbsolute,join} from 'node:path';
import {lstat,realpath,readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHmac,createPrivateKey,createPublicKey} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {fieldObject,fieldText,fieldSha256,parsePublicFieldProfile} from '../integrations/field-profile.ts';
import {fieldLeaseKeyId} from '../integrations/field-lease.ts';
import {fieldRecoveryControl} from '../integrations/field-recovery.ts';
import {fieldRegistrySnapshot} from '../server/field-registry.ts';
import {fieldEdgeDirectoryName} from '../services/field/edge-config.ts';
import {readRuntimeColdReviewWithFieldSourceV2} from './runtime-cold-readonly-control-v7.mjs';
import {fieldMapSiteRuntimeConfigV1} from './field-map-site-runtime-v1.mjs';
import {fieldMapAuthorityGatewayConfigV1} from './field-map-authority-gateway-v1.mjs';
import {fieldMapAuthorityHostConfigV1} from './field-map-authority-host-v1.mjs';
import {mqttBrokerRuntimeV1,mqttBrokerMaterialsV1,inspectMqttBrokerRuntimeV1} from './mqtt-broker-runtime-v1.mjs';
import {readActivationMaterialFile} from './field-activation-material-files.mjs';
import {loadColdFieldSourceMaterialSetV2} from './cold-field-material-source-files-v2.mjs';

const same=(a,b)=>canonical(a)===canonical(b),normal=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const pathValue=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&isAbsolute(value)&&value===resolve(value)&&!/[\u0000-\u001f\u007f]/.test(value);
const inside=(path,root)=>{const value=relative(normal(root),normal(path));return value!==''&&value!=='..'&&!value.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&!isAbsolute(value);};
const decode=bytes=>JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
function safeError(error){const value=error?.code??error?.message,code=typeof value==='string'&&/^(?:COLD_FIELD_DEPLOYMENT|COLD_FIELD_MATERIAL|FIELD_ACTIVATION|FIELD_EDGE_CONFIG|MQTT_BROKER)_[A-Z0-9_]+$/.test(value)?value:'COLD_FIELD_DEPLOYMENT_UNVERIFIABLE';return Object.assign(Error(code),{code});}

/**
 * Whole SOURCE configuration/credential file compiler only. It opens no SQL,
 * device or application session and cannot authorize HELD review or activation.
 * Current target accounts, live broker ACL, actual startup
 * program approval must still be proved by the complete cold coordinator.
 */
export async function loadColdFieldDeploymentMaterialFilesV3(configurationFile,raw,key){
  need(exact(raw,['trust','roots','workDirectory'])&&pathValue(raw.workDirectory)&&Array.isArray(raw.roots)&&raw.roots.length>0&&raw.roots.length<=16&&raw.roots.every(pathValue)&&pathValue(configurationFile),'COLD_FIELD_DEPLOYMENT_CONTEXT');
  need(Buffer.isBuffer(key)&&key.length===32,'COLD_FIELD_DEPLOYMENT_MAC_KEY');
  const context=structuredClone(raw),state=await readRuntimeColdReviewWithFieldSourceV2(context.trust),source=state.source,field=source.fieldSource;
  const forbidden=[source.inventory.identity.directory,state.details.targetDirectory].filter(pathValue);
  const inventory=new Map(),aliases=new Map(),tenants=[],loadedBrokers=[],buffers=[],emptySidecarWitnesses=[],spoolContexts=[],historicalMaterials=[],historyOwners=[],spoolProofs=[],spoolDirectories=new Set();let total=0,closed=false;
  const allowed=path=>need(pathValue(path)&&context.roots.some(root=>inside(path,root))&&forbidden.every(root=>normal(path)!==normal(root)&&!inside(path,root)),'COLD_FIELD_DEPLOYMENT_PATH');
  const clear=()=>{if(closed)return;closed=true;for(const value of tenants)value.materials.clear();for(const value of inventory.values())value.bytes.fill(0);for(const bytes of buffers)bytes.fill(0);};
  const read=async(path,purpose='PRIVATE_JSON',maximumBytes=2*1024**2)=>{
    need(!closed,'COLD_FIELD_DEPLOYMENT_CLOSED');allowed(path);
    const alias=normal(path);need(!aliases.has(alias)||aliases.get(alias)===path,'COLD_FIELD_DEPLOYMENT_PATH_ALIAS');aliases.set(alias,path);
    const prior=inventory.get(path);if(prior){need(prior.purpose===purpose||[prior.purpose,purpose].every(value=>value.startsWith('PRIVATE_')),'COLD_FIELD_DEPLOYMENT_FILE_ROLE_ALIAS');return prior.bytes;}
    const bytes=await readActivationMaterialFile(path,maximumBytes);total+=bytes.length;
    if(total>256*1024**2){bytes.fill(0);need(false,'COLD_FIELD_DEPLOYMENT_SIZE');}
    inventory.set(path,{purpose,bytes,maximumBytes});return bytes;
  };
  const emptySidecar=async path=>{
    allowed(path);const parents=[];
    for(let parent=dirname(path);;parent=dirname(parent)){const stat=await lstat(parent,{bigint:true});need(stat.isDirectory()&&!stat.isSymbolicLink()&&normal(await realpath(parent))===normal(parent),'COLD_FIELD_DEPLOYMENT_PATH');parents.push({path:parent,dev:String(stat.dev),ino:String(stat.ino)});if(dirname(parent)===parent)break;}
    const identity=stat=>({dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs),nlink:String(stat.nlink)});
    const before=await lstat(path,{bigint:true});need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size===0n&&normal(await realpath(path))===normal(path),'COLD_FIELD_DEPLOYMENT_EMPTY_SIDECAR');
    let handle;try{
      handle=await open(path,constants.O_RDONLY|constants.O_NONBLOCK|(constants.O_NOFOLLOW??0));need(same(identity(await handle.stat({bigint:true})),identity(before)),'COLD_FIELD_DEPLOYMENT_EMPTY_SIDECAR');
      need((await handle.read(Buffer.alloc(1),0,1,0)).bytesRead===0,'COLD_FIELD_DEPLOYMENT_EMPTY_SIDECAR');
      const after=await lstat(path,{bigint:true});need(after.isFile()&&!after.isSymbolicLink()&&same(identity(after),identity(before))&&same(identity(await handle.stat({bigint:true})),identity(before))&&normal(await realpath(path))===normal(path),'COLD_FIELD_DEPLOYMENT_EMPTY_SIDECAR');
      for(const parent of parents){const stat=await lstat(parent.path,{bigint:true});need(stat.isDirectory()&&!stat.isSymbolicLink()&&String(stat.dev)===parent.dev&&String(stat.ino)===parent.ino&&normal(await realpath(parent.path))===normal(parent.path),'COLD_FIELD_DEPLOYMENT_EMPTY_SIDECAR');}
      emptySidecarWitnesses.push({path,purpose:'EMPTY_SQLITE_WAL_IDENTITY_V1',identity:identity(before),parents});
    }finally{await handle?.close();}
  };
  const json=async path=>decode(await read(path));
  const referenced=(file,name)=>{fieldText(name,4096);return resolve(dirname(file),name);};
  const directory=async path=>{allowed(path);const stat=await lstat(path);need(stat.isDirectory()&&!stat.isSymbolicLink()&&normal(await realpath(path))===normal(path),'COLD_FIELD_DEPLOYMENT_DIRECTORY');};
  try{
    await directory(context.workDirectory);
    const rawDescriptor=await json(configurationFile),descriptor=fieldObject(rawDescriptor,rawDescriptor.format==='idms-cold-field-deployment-materials-v2'?['format','siteRuntimeFile','brokerRuntimeFile','tenantMaterials','historicalStreamMaterials']:['format','siteRuntimeFile','brokerRuntimeFile','tenantMaterials']);
    const declaredHistorical=descriptor.historicalStreamMaterials??[];need(Array.isArray(declaredHistorical)&&declaredHistorical.length<=4096,'COLD_FIELD_DEPLOYMENT_HISTORICAL_MATERIALS');
    need(['idms-cold-field-deployment-materials-v1','idms-cold-field-deployment-materials-v2'].includes(descriptor.format)&&pathValue(descriptor.siteRuntimeFile)&&Array.isArray(descriptor.tenantMaterials),'COLD_FIELD_DEPLOYMENT_DESCRIPTOR');
    const site=fieldMapSiteRuntimeConfigV1(await json(descriptor.siteRuntimeFile));
    const siteBaseFile=referenced(descriptor.siteRuntimeFile,site.baseRuntimeFile),siteBase=await json(siteBaseFile);need(siteBase&&typeof siteBase==='object'&&!Array.isArray(siteBase),'COLD_FIELD_DEPLOYMENT_SITE_BASE');
    need(site.field.enabled===field.ownerEvidence.siteFieldEnabled,'COLD_FIELD_DEPLOYMENT_SOURCE_MODE');
    const configured=field.configuredTenants.map(value=>value.tenantId).sort();
    for(const value of descriptor.tenantMaterials)need(exact(value,['tenantId','configurationFile'])&&typeof value.tenantId==='string'&&pathValue(value.configurationFile),'COLD_FIELD_DEPLOYMENT_TENANT_DESCRIPTOR');
    need(same(descriptor.tenantMaterials.map(value=>value.tenantId).sort(),configured),'COLD_FIELD_DEPLOYMENT_TENANT_COVERAGE');
    const sourceBinding={format:'COLD_FIELD_DEPLOYMENT_SOURCE_BINDING_V1',controlId:context.trust.controlId,sourceHash:context.trust.sourceHash,fieldSourceSha256:field.sha256,configuredTenantIds:configured,siteFieldEnabled:site.field.enabled};
    const historicalSlots=new Set();
    for(const entry of declaredHistorical){
      need(exact(entry,['tenantId','edgeId','streamId','profileFile','eventKeyFile','platformPublicKeyFile'])&&configured.includes(entry.tenantId)&&typeof entry.edgeId==='string'&&typeof entry.streamId==='string'&&/^[a-f0-9]{64}$/.test(entry.streamId)&&[entry.profileFile,entry.eventKeyFile,entry.platformPublicKeyFile].every(pathValue),'COLD_FIELD_DEPLOYMENT_HISTORICAL_MATERIAL');
      need(field.configuredTenants.find(value=>value.tenantId===entry.tenantId).channels.some(value=>value.edgeId===entry.edgeId),'COLD_FIELD_DEPLOYMENT_HISTORICAL_CHANNEL');
      const slot=entry.tenantId+'/'+entry.edgeId+'/'+entry.streamId;need(!historicalSlots.has(slot),'COLD_FIELD_DEPLOYMENT_HISTORICAL_DUPLICATE');historicalSlots.add(slot);
      const profile=parsePublicFieldProfile(await json(entry.profileFile)),eventKey=await read(entry.eventKeyFile,'PRIVATE_BINARY',32),pem=await read(entry.platformPublicKeyFile,'PRIVATE_BINARY',16384);need(/^\s*-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem.toString('utf8')),'COLD_FIELD_DEPLOYMENT_HISTORICAL_PUBLIC_KEY');const publicKey=createPublicKey(pem);
      need(profile.transport&&profile.source.tenantId===entry.tenantId&&profile.source.edgeId===entry.edgeId&&eventKey.length===32&&!eventKey.every(value=>value===0)&&fieldSha256(eventKey)===profile.transport.eventKeySha256&&fieldLeaseKeyId(publicKey)===profile.transport.acknowledgementKeyId,'COLD_FIELD_DEPLOYMENT_HISTORICAL_KEYS');
      historicalMaterials.push({...entry,profile,eventKey,publicKey});
    }
    let gateway,host,broker,brokerPublic=null;const programFiles=[],spoolFiles=[];
    if(!site.field.enabled){need(descriptor.brokerRuntimeFile===null&&configured.length===0&&descriptor.tenantMaterials.length===0&&historicalMaterials.length===0,'COLD_FIELD_DEPLOYMENT_DISABLED_FILES');}
    else{
      need(pathValue(descriptor.brokerRuntimeFile)&&configured.length>0,'COLD_FIELD_DEPLOYMENT_BROKER_DESCRIPTOR');
      const gatewayFile=referenced(descriptor.siteRuntimeFile,site.field.gatewayFile);gateway=fieldMapAuthorityGatewayConfigV1(await json(gatewayFile));need(gateway.enabled,'COLD_FIELD_DEPLOYMENT_GATEWAY_DISABLED');
      const hostFile=referenced(gatewayFile,gateway.authorityHostFile),platformFile=referenced(gatewayFile,gateway.platformFile),intakeFile=referenced(gatewayFile,gateway.intakeFile);
      host=fieldMapAuthorityHostConfigV1(await json(hostFile));
      need(same(host.tenants.map(value=>value.tenantId).sort(),configured),'COLD_FIELD_DEPLOYMENT_HOST_TENANTS');
      // The actual current target account and authority are deliberately not
      // inferred from these files. Their bytes are included for later checks.
      await read(referenced(hostFile,host.coldTrustFile));await read(referenced(hostFile,host.authorityRuntimeFile));
      const platform=fieldObject(await json(platformFile),['format','leaseSigningKeyFile','tenants']);
      need(platform.format==='idms-field-platform-config-v2'&&Array.isArray(platform.tenants)&&same(platform.tenants.map(value=>value?.tenantId).sort(),configured),'COLD_FIELD_DEPLOYMENT_PLATFORM_TENANTS');
      const signerFile=resolve(dirname(platformFile),fieldEdgeDirectoryName(platform.leaseSigningKeyFile)),signerBytes=await read(signerFile,'PRIVATE_BINARY',4096);
      const signer=createPrivateKey(signerBytes);need(signer.asymmetricKeyType==='ed25519','COLD_FIELD_DEPLOYMENT_SIGNER_TYPE');const signerId=fieldLeaseKeyId(createPublicKey(signer));
      const intake=fieldObject(await json(intakeFile),['format','tenants']);need(intake.format==='idms-field-platform-intake-v1'&&Array.isArray(intake.tenants)&&same(intake.tenants.map(value=>value?.tenantId).sort(),configured),'COLD_FIELD_DEPLOYMENT_INTAKE_TENANTS');
      const secretHashes=new Set(),allChannels=[];
      for(const selected of descriptor.tenantMaterials){
        const sourceTenant=field.configuredTenants.find(value=>value.tenantId===selected.tenantId),sourceMap=field.fieldMaps.find(value=>value.binding.tenantId===selected.tenantId),registry=fieldRegistrySnapshot(sourceMap.fieldFacts.registryHead.snapshot);
        need(signerId===registry.leaseKeyId,'COLD_FIELD_DEPLOYMENT_SIGNER_SOURCE');
        const platformTenant=fieldObject(platform.tenants.find(value=>value.tenantId===selected.tenantId),['tenantId','recoveryFile','channels']);
        need(Array.isArray(platformTenant.channels)&&platformTenant.channels.length===sourceTenant.channels.length,'COLD_FIELD_DEPLOYMENT_PLATFORM_CHANNELS');
        const recoveryFile=resolve(dirname(platformFile),fieldEdgeDirectoryName(platformTenant.recoveryFile)),recovery=fieldRecoveryControl(await json(recoveryFile));
        need(recovery.tenantId===selected.tenantId&&same(recovery.identity,sourceTenant.recoveryIdentity),'COLD_FIELD_DEPLOYMENT_RECOVERY_IDENTITY');
        const materials=await loadColdFieldSourceMaterialSetV2(selected.configurationFile,{trust:context.trust,tenantId:selected.tenantId,roots:context.roots},key);tenants.push({tenantId:selected.tenantId,materials});
        const materialConfig=decode(await read(selected.configurationFile));need(normal(materialConfig.intakeConfigurationFile)===normal(intakeFile),'COLD_FIELD_DEPLOYMENT_INTAKE_ALIAS');
        for(const file of materials.privateFiles)await read(file.path,'PRIVATE_BINARY',Math.max(1,file.bytes));
        const seen=new Set();
        for(const channel of platformTenant.channels){
          const entry=fieldObject(channel,['profile','requestKeyFile','eventKeyFile']),profile=parsePublicFieldProfile(entry.profile),loaded=materials.channels.find(value=>value.edgeId===profile.source.edgeId);
          need(loaded&&!seen.has(loaded.edgeId)&&profile.source.tenantId===selected.tenantId&&same(profile,loaded.profile),'COLD_FIELD_DEPLOYMENT_PLATFORM_PROFILE');seen.add(loaded.edgeId);
          const request=await read(resolve(dirname(platformFile),fieldEdgeDirectoryName(entry.requestKeyFile)),'PRIVATE_BINARY',32),event=await read(resolve(dirname(platformFile),fieldEdgeDirectoryName(entry.eventKeyFile)),'PRIVATE_BINARY',32);
          need(request.equals(loaded.edge.lease.requestKey),'COLD_FIELD_DEPLOYMENT_PLATFORM_REQUEST_KEY');need(event.equals(loaded.edge.eventKey)&&fieldSha256(event)===profile.transport.eventKeySha256,'COLD_FIELD_DEPLOYMENT_PLATFORM_EVENT_KEY');
          for(const value of [request,event]){const digest=fieldSha256(value);need(value.length===32&&!value.every(byte=>byte===0)&&!secretHashes.has(digest),'COLD_FIELD_DEPLOYMENT_KEY_REUSED');secretHashes.add(digest);}
          allChannels.push({tenantId:selected.tenantId,edgeId:loaded.edgeId});
          const spool=resolve(loaded.edge.root,loaded.edge.spool.directory);await directory(spool);
          need(!spoolDirectories.has(normal(spool))&&normal(context.workDirectory)!==normal(spool)&&!inside(context.workDirectory,spool),'COLD_FIELD_DEPLOYMENT_SPOOL_DIRECTORY_ALIAS');spoolDirectories.add(normal(spool));
          const names=await readdir(spool,{withFileTypes:true}),databases=new Set(names.filter(value=>/^stream-[a-f0-9]{64}\.sqlite$/.test(value.name)).map(value=>value.name));need(databases.size<=loaded.edge.spool.maxStreams&&names.length<=loaded.edge.spool.maxStreams*3,'COLD_FIELD_DEPLOYMENT_SPOOL_COUNT');
          for(const name of names){
            need(name.isFile()&&!name.isSymbolicLink()&&/^stream-[a-f0-9]{64}\.sqlite(?:-wal|-shm)?$/.test(name.name),'COLD_FIELD_DEPLOYMENT_SPOOL_OFFLINE');const path=join(spool,name.name);
            if(name.name.endsWith('-wal')){need(databases.has(name.name.slice(0,-4)),'COLD_FIELD_DEPLOYMENT_SPOOL_SIDECAR_ORPHAN');need((await lstat(path,{bigint:true})).size===0n,'COLD_FIELD_DEPLOYMENT_SPOOL_WAL_NONEMPTY');await emptySidecar(path);}
            else if(name.name.endsWith('-shm')){need(databases.has(name.name.slice(0,-4)),'COLD_FIELD_DEPLOYMENT_SPOOL_SIDECAR_ORPHAN');const bytes=await read(path,'PRIVATE_BINARY',1048576);need(bytes.length>=32768&&bytes.length%32768===0,'COLD_FIELD_DEPLOYMENT_SPOOL_SHM');}
            else{const bytes=await read(path,'PRIVATE_BINARY',Math.min(256*1024**2,loaded.edge.spool.maxBytes*4+1024**2));spoolFiles.push(path);spoolContexts.push({tenantId:selected.tenantId,edgeId:loaded.edgeId,streamId:name.name.slice(7,-7),path,bytes,channel:loaded});}
          }
        }
        need(seen.size===materials.channels.length,'COLD_FIELD_DEPLOYMENT_PLATFORM_CHANNELS');
      }
      broker=mqttBrokerRuntimeV1(await json(descriptor.brokerRuntimeFile));
      const ordered=values=>values.map(value=>value.tenantId+'/'+value.edgeId).sort();need(same(ordered(broker.channels),ordered(allChannels)),'COLD_FIELD_DEPLOYMENT_BROKER_CHANNELS');
      const paths={ca:broker.server.caFile,server:broker.server.certificateFile,serverKey:broker.server.keyFile,probe:broker.probe.certificateFile,probeKey:broker.probe.keyFile},materialBytes={};
      for(const [name,path]of Object.entries(paths))materialBytes[name]=await read(path,'PRIVATE_BINARY',65536);
      brokerPublic=mqttBrokerMaterialsV1(broker,materialBytes);
      for(const tenant of tenants)for(const channel of tenant.materials.channels){const url=new URL(channel.platform.url);need(url.hostname===broker.host&&Number(url.port)===broker.port&&channel.profile.transport.serverCertificateSha256===brokerPublic.serverCertificateSha256&&channel.profile.transport.caCertificateSha256===brokerPublic.caCertificateSha256,'COLD_FIELD_DEPLOYMENT_BROKER_BINDING');}
      await directory(broker.toolingDirectory);const names=[process.platform==='win32'?'mosquitto.exe':'mosquitto'];
      if(process.platform==='win32')for(const value of await readdir(broker.toolingDirectory,{withFileTypes:true}))if(value.name.toLowerCase().endsWith('.dll')){need(value.isFile()&&!value.isSymbolicLink(),'COLD_FIELD_DEPLOYMENT_PROGRAM_FILE');names.push(value.name);}
      for(const name of names){const path=join(broker.toolingDirectory,name);await read(path,'PUBLIC_PROGRAM',32*1024**2);programFiles.push(path);}
      const inspected=await inspectMqttBrokerRuntimeV1(descriptor.brokerRuntimeFile);loadedBrokers.push(inspected);for(const bytes of Object.values(inspected.materials))buffers.push(bytes);
      need(same(inspected.config,broker)&&same(inspected.materialBinding,brokerPublic),'COLD_FIELD_DEPLOYMENT_BROKER_CHANGED');
      for(const pin of inspected.pins){const value=inventory.get(pin.path);need(value&&fieldSha256(value.bytes)===pin.sha256,'COLD_FIELD_DEPLOYMENT_BROKER_CHANGED');}
    }
    const allEventKeys=new Map();
    for(const tenant of tenants)for(const channel of tenant.materials.channels)for(const [role,bytes]of [['REQUEST',channel.edge.lease.requestKey],['EVENT',channel.edge.eventKey]])allEventKeys.set(fieldSha256(bytes),{tenantId:tenant.tenantId,edgeId:channel.edgeId,role});
    for(const material of historicalMaterials){const digest=fieldSha256(material.eventKey),prior=allEventKeys.get(digest);need(!prior||prior.tenantId===material.tenantId&&prior.edgeId===material.edgeId&&prior.role==='EVENT','COLD_FIELD_DEPLOYMENT_HISTORICAL_KEY_REUSED');allEventKeys.set(digest,{tenantId:material.tenantId,edgeId:material.edgeId,role:'EVENT'});}
    for(const tenant of tenants){
      const keys=new Map();for(const key of [...tenant.materials.channels.map(value=>value.edge.lease.publicKey),...historicalMaterials.filter(value=>value.tenantId===tenant.tenantId).map(value=>value.publicKey)])keys.set(fieldLeaseKeyId(key),key);
      const history=await readColdFieldSourceHistoryV2({trust:context.trust,tenantId:tenant.tenantId,publicKeys:[...keys.values()],workDirectory:context.workDirectory},key);historyOwners.push(history);
      need(history.sourceBinding.fieldSourceSha256===field.sha256&&history.sourceBinding.sourceHash===context.trust.sourceHash,'COLD_FIELD_DEPLOYMENT_HISTORY_SOURCE');
      for(const material of historicalMaterials.filter(value=>value.tenantId===tenant.tenantId)){
        const found=history.history.issuances.some(issued=>{if(issued.body.edgeId!==material.edgeId||issued.body.profileDigest!==publicFieldProfileDigest(material.profile))return false;const registry=history.history.registries.find(value=>value.auditEventId===issued.registryEventId);return registry?.snapshot.channels.some(value=>same(value.profile,material.profile))&&coldFieldSourceStreamBindingV1(material.profile,issued.body,material.publicKey).streamId===material.streamId;});
        need(found,'COLD_FIELD_DEPLOYMENT_HISTORICAL_SOURCE_STREAM');
      }
      for(const spool of spoolContexts.filter(value=>value.tenantId===tenant.tenantId)){
        const historical=historicalMaterials.find(value=>value.tenantId===spool.tenantId&&value.edgeId===spool.edgeId&&value.streamId===spool.streamId),material=historical??{profile:spool.channel.profile,eventKey:spool.channel.edge.eventKey,publicKey:spool.channel.edge.lease.publicKey};
        const proof=await inspectColdFieldSourceSpoolV2(spool.bytes,{trust:context.trust,tenantId:tenant.tenantId,profile:material.profile,streamId:spool.streamId,eventKey:material.eventKey,platformPublicKey:material.publicKey,historyPublicKeys:[...keys.values()],capacity:spool.channel.edge.spool.capacity,maxBytes:spool.channel.edge.spool.maxBytes,workDirectory:context.workDirectory},key,history);
        spoolProofs.push({tenantId:tenant.tenantId,edgeId:spool.edgeId,streamId:spool.streamId,privateFingerprint:proof.fingerprint,evidence:proof.evidence});
      }
    }
    const after=await readRuntimeColdReviewWithFieldSourceV2(context.trust);need(same(after.source,source),'COLD_FIELD_DEPLOYMENT_SOURCE_CHANGED');
    const mac=createHmac('sha256',key).update('IDMS_COLD_FIELD_DEPLOYMENT_SOURCE_FILES_V3\n'+canonical(sourceBinding)+'\n');
    for(const [path,value]of [...inventory].sort(([a],[b])=>a.localeCompare(b))){mac.update(canonical({path,purpose:value.purpose,bytes:value.bytes.length})+'\n');mac.update(value.bytes);mac.update('\n');}
    for(const witness of [...emptySidecarWitnesses].sort((a,b)=>a.path.localeCompare(b.path)))mac.update(canonical(witness)+'\n');
    for(const tenant of [...tenants].sort((a,b)=>a.tenantId.localeCompare(b.tenantId)))mac.update(canonical({tenantId:tenant.tenantId,privateMaterialMac:tenant.materials.fingerprint})+'\n');
    for(const proof of [...spoolProofs].sort((a,b)=>[a.tenantId,a.edgeId,a.streamId].join('/').localeCompare([b.tenantId,b.edgeId,b.streamId].join('/'))))mac.update(canonical(proof)+'\n');
    const privateFiles=[...inventory].map(([path,value])=>({path,purpose:value.purpose,maximumBytes:value.bytes.length,bytes:value.bytes.length}));
    const evidence={format:'COLD_FIELD_DEPLOYMENT_SOURCE_FILES_V3',sourceBinding,configuredTenants:configured.length,channels:tenants.reduce((count,value)=>count+value.materials.channels.length,0),files:privateFiles.length+emptySidecarWitnesses.length,emptyWalIdentityWitnesses:emptySidecarWitnesses.length,programFiles:programFiles.length,offlineSpoolFiles:spoolFiles.length,brokerCertificateBindings:brokerPublic,fieldConfigurationAndCredentialGraphCovered:true,coreAuthorityConfigurationReferencesDelegatedToCoreCompiler:true,sourceOnly:true,currentHeldSessionVerified:false,currentTargetSqlAndIdentityVerified:false,actualTransportObserved:false,brokerTopicAclVerified:false,offlineSpoolSemanticsVerified:true,allCapturedSpoolStreamsBoundToSourceHistory:true,historicalStreamMaterialSets:historicalMaterials.length,spoolStreamsVerified:spoolProofs.length,actualStartupProgramsApproved:false,completeFieldMaterialsVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false};
    return {sourceBinding,tenants,site,gateway,host,broker,privateFiles,emptySidecarWitnesses,spoolProofs,fingerprint:mac.digest('hex'),evidence,clear,toJSON(){need(false,'COLD_FIELD_DEPLOYMENT_PRIVATE_ONLY');}};
  }catch(error){clear();throw safeError(error);}finally{for(const value of historyOwners)value.close();historyOwners.length=0;}
}
