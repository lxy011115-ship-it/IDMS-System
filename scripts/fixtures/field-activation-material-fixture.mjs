import {randomUUID,randomBytes,generateKeyPairSync} from 'node:crypto';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import {createFieldOpcuaServer} from './field-opcua-server.mjs';
import {fieldMqttCertificateFixture} from './field-mqtt-fixture.mjs';
import {createFieldMqttBroker} from './field-mqtt-broker.mjs';
import {fieldRecoveryFixture} from './field-recovery-fixture.mjs';
import {publicFieldProfile} from '../../services/field/profile.ts';
import {fieldRegistrySnapshot} from '../../server/field-registry.ts';
import {fieldRegistrationCandidate} from '../../server/field-recovery-registration.ts';
import {fieldSha256,publicFieldProfileDigest} from '../../integrations/field-profile.ts';
import {fieldLeaseKeyId} from '../../integrations/field-lease.ts';
import {canonical} from '../../server/imports.ts';
import {privateDirectory} from '../backup-support.mjs';
import {writePrivate} from '../keycloak-local.mjs';
export async function activationMaterialFixture(){
 const base=resolve('work/field-channel-20261017'),directory=resolve(base,'activation-materials-'+randomUUID().replaceAll('-','').slice(0,10));await mkdir(directory);await privateDirectory(directory);
 let opc,mqtt,broker;const files=new Map(),keys=generateKeyPairSync('ed25519'),requestKey=randomBytes(32),password='owned-inspection-'+randomBytes(16).toString('base64url');
 const write=async(name,data)=>{const path=resolve(directory,name);await writePrivate(path,data);files.set(name,Buffer.from(data));return path;};
 const close=async()=>{await broker?.close();await opc?.close();requestKey.fill(0);const rel=relative(base,directory);if(isAbsolute(rel)||rel.startsWith('..')||!/^activation-materials-[a-f0-9]{10}$/.test(basename(directory)))throw Error('Unowned material QA workspace');await rm(directory,{recursive:true,force:true});};
 try{
  opc=await createFieldOpcuaServer({userIdentity:{userName:'owned-inspection',password}});mqtt=await fieldMqttCertificateFixture(opc.profile.source,{directory});broker=await createFieldMqttBroker(mqtt);
  const privateProfile=structuredClone(opc.profile);privateProfile.format='idms-field-channel-profile-v2';privateProfile.userIdentity={type:'UserName',userName:'owned-inspection',passwordFile:'opc-password.txt'};privateProfile.transport={...mqtt.declaration(broker.url),acknowledgementKeyId:fieldLeaseKeyId(keys.publicKey)};
  await write('server.der',opc.materials.serverCertificate);await write('client.der',opc.materials.clientCertificate);await write('client-key.pem',opc.materials.privateKeyPem);await write('opc-password.txt',password);await write('request.bin',requestKey);await write('event.bin',mqtt.eventKey);await write('platform-public.pem',keys.publicKey.export({type:'spki',format:'pem'}));
  const profile=publicFieldProfile(privateProfile),operationId=randomUUID(),control=fieldRecoveryFixture(),registry=fieldRegistrySnapshot({format:'idms-field-registry-v2',tenantId:'acme',recovery:control.identity,leaseKeyId:fieldLeaseKeyId(keys.publicKey),channels:[{profile,profileDigest:publicFieldProfileDigest(profile),requestKeySha256:fieldSha256(requestKey)}]}),registration=fieldRegistrationCandidate({format:'idms-field-recovery-registration-candidate-v1',tenantId:'acme',operationId,controlSha256:'a'.repeat(64),operationIntentSha256:'b'.repeat(64),configSha256:'c'.repeat(64),registry,registrySha256:fieldSha256(canonical(registry)),fieldEnabled:false,activationGranted:false});
  await write('profile.json',canonical(privateProfile));const transport=role=>({url:broker.url,caFile:'ca.pem',serverCertificateFile:'broker.pem',clientCertificateFile:role==='EDGE'?'edge.pem':'platform.pem',privateKeyFile:role==='EDGE'?'edge.key':'platform.key'});
  const edge={format:'idms-field-edge-config-v1',profileFile:'profile.json',lease:{url:'http://127.0.0.1:9/api/v1/field-channel/lease',requestKeyFile:'request.bin',platformPublicKeyFile:'platform-public.pem',timeoutMs:1000,renewBeforeMs:500},eventKeyFile:'event.bin',mqtt:transport('EDGE'),spool:{directory:'spool',capacity:100,maxBytes:131072,maxStreams:4},schedule:{sampleIntervalMs:1000,retryMs:100,ackTimeoutMs:500,batchLimit:10,onceTimeoutMs:10000,retryBackoffMs:1000}};
  await write('edge.json',canonical(edge));const intake=await write('intake.json',canonical({format:'idms-field-platform-intake-v1',tenants:[{tenantId:'acme',channels:[{edgeId:profile.source.edgeId,mqtt:transport('PLATFORM')}]}]}));
  const configuration=await write('materials.json',canonical({format:'idms-field-activation-materials-v1',tenantId:'acme',intakeConfigurationFile:intake,edges:[{edgeId:profile.source.edgeId,configurationFile:resolve(directory,'edge.json')}]}));
  return {directory,opc,mqtt,broker,profile,privateProfile,registration,configuration,files,write,password,close,modelRegistrationOnlyNoDatabaseApproval:true};
 }catch(e){await close();throw e;}
}
