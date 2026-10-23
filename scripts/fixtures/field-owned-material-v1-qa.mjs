import {randomUUID,randomBytes,generateKeyPairSync} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fieldCertificateFixture,fieldProfileFixture} from './field-certificate-fixture.mjs';
import {fieldOwnedMqttMaterialFixtureV1} from './field-owned-mqtt-material-v1-qa.mjs';
import {fieldRecoveryFixture} from './field-recovery-fixture.mjs';
import {publicFieldProfile} from '../../services/field/profile.ts';
import {fieldRegistrySnapshot} from '../../server/field-registry.ts';
import {fieldRegistrationCandidate} from '../../server/field-recovery-registration.ts';
import {fieldSha256,publicFieldProfileDigest} from '../../integrations/field-profile.ts';
import {fieldLeaseKeyId} from '../../integrations/field-lease.ts';
import {canonical} from '../../server/imports.ts';
import {privateDirectory} from '../backup-support.mjs';

/** Files and certificates only: no OPC UA, broker, issuer or database is started. */
export async function fieldOwnedMaterialFixtureV1(leaseUrl){
  const directory=resolve('work/edge-owned-lifecycle-20261024','owned-materials-'+randomUUID());
  await mkdir(directory,{recursive:true});await privateDirectory(directory);
  const server=await fieldCertificateFixture(),client=await fieldCertificateFixture({applicationUri:'urn:idms:field-qa-client'}),profile=fieldProfileFixture(server,client);
  profile.source.edgeId=randomUUID();
  const mqtt=await fieldOwnedMqttMaterialFixtureV1(profile.source,directory),keys=generateKeyPairSync('ed25519'),requestKey=randomBytes(32),url='mqtts://127.0.0.1:9';
  profile.format='idms-field-channel-profile-v2';profile.transport={...mqtt.declaration(url),acknowledgementKeyId:fieldLeaseKeyId(keys.publicKey)};
  const write=async(name,data)=>{const path=resolve(directory,name);await writeFile(path,data,{mode:0o600});return path;};
  await write('server.der',server.der);await write('client.der',client.der);await write('client-key.pem',client.privateKey);
  await write('request.bin',requestKey);await write('event.bin',mqtt.eventKey);await write('platform-public.pem',keys.publicKey.export({type:'spki',format:'pem'}));
  await write('profile.json',canonical(profile));
  const transport=role=>({url,caFile:'ca.pem',serverCertificateFile:'broker.pem',clientCertificateFile:role==='EDGE'?'edge.pem':'platform.pem',privateKeyFile:role==='EDGE'?'edge.key':'platform.key'});
  const edge={format:'idms-field-edge-config-v1',profileFile:'profile.json',lease:{url:leaseUrl,requestKeyFile:'request.bin',platformPublicKeyFile:'platform-public.pem',timeoutMs:10000,renewBeforeMs:1000},eventKeyFile:'event.bin',mqtt:transport('EDGE'),spool:{directory:'spool',capacity:2,maxBytes:1048576,maxStreams:4},schedule:{sampleIntervalMs:500,retryMs:100,ackTimeoutMs:750,batchLimit:10,onceTimeoutMs:20000,retryBackoffMs:1000}};
  const edgeConfigurationFile=await write('edge.json',canonical(edge)),publicProfile=publicFieldProfile(profile);
  const intakeConfigurationFile=await write('intake.json',canonical({format:'idms-field-platform-intake-v1',tenants:[{tenantId:'acme',channels:[{edgeId:profile.source.edgeId,mqtt:transport('PLATFORM')}]}]}));
  const configurationFile=await write('materials.json',canonical({format:'idms-field-activation-materials-v1',tenantId:'acme',intakeConfigurationFile,edges:[{edgeId:profile.source.edgeId,configurationFile:edgeConfigurationFile}]}));
  const recovery=fieldRecoveryFixture(),registry=fieldRegistrySnapshot({format:'idms-field-registry-v2',tenantId:'acme',recovery:recovery.identity,leaseKeyId:fieldLeaseKeyId(keys.publicKey),channels:[{profile:publicProfile,profileDigest:publicFieldProfileDigest(publicProfile),requestKeySha256:fieldSha256(requestKey)}]});
  const registration=fieldRegistrationCandidate({format:'idms-field-recovery-registration-candidate-v1',tenantId:'acme',operationId:randomUUID(),controlSha256:'a'.repeat(64),operationIntentSha256:'b'.repeat(64),configSha256:'c'.repeat(64),registry,registrySha256:fieldSha256(canonical(registry)),fieldEnabled:false,activationGranted:false});
  return {directory,edge,source:profile.source,configurationFile,edgeConfigurationFile,edgeId:profile.source.edgeId,registration,workDirectory:directory,registrationIsModelOnly:true};
}
