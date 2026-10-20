import {createPrivateKey,type KeyObject} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {readBoundedFieldFile,readFieldMaterial} from '../services/field/profile.ts';
import {fieldObject,fieldText,fieldHash,fieldSha256,publicFieldProfileDigest,parsePublicFieldProfile,freezeFieldValue,type PublicFieldProfile} from '../integrations/field-profile.ts';
import {fieldLeaseKeyId} from '../integrations/field-lease.ts';
import {fieldRegistrySnapshot,type FieldRegistrySnapshot} from './field-registry.ts';
import {loadFieldRecoveryHandle,type FieldRecoveryHandle} from './field-recovery-read.ts';
import {DomainError} from './service.ts';
import {stable} from '../integrations/telemetry.ts';
import {fieldRecoveryControl,type FieldRecoveryControl} from '../integrations/field-recovery.ts';
import {fieldRegistrationCandidate} from './field-recovery-registration.ts';
export interface FieldPrivateChannel {profile:PublicFieldProfile;requestKey:Buffer;eventKey?:Buffer}
export interface FieldPlatformConfig {signingKey:KeyObject;leaseKeyId:string;tenants:Map<string,{snapshot:FieldRegistrySnapshot;recovery?:FieldRecoveryHandle;channels:Map<string,FieldPrivateChannel>}>}
export function clearFieldPlatformConfig(config:FieldPlatformConfig){for(const t of config.tenants.values())for(const c of t.channels.values()){c.requestKey.fill(0);c.eventKey?.fill(0);}config.tenants.clear();}
export async function loadFieldPlatformConfig(path:string):Promise<FieldPlatformConfig>{return readPlatformConfig(path,loadFieldRecoveryHandle);}
async function readPlatformConfig(path:string,recover:typeof loadFieldRecoveryHandle):Promise<FieldPlatformConfig>{
 let keyBytes:Buffer|undefined;const secrets:Buffer[]=[];
 try{const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedFieldFile(path,2097152))),r=fieldObject(raw,['format','leaseSigningKeyFile','tenants']);const fenced=r.format==='idms-field-platform-config-v2';if(!fenced&&r.format!=='idms-field-platform-config-v1'||!Array.isArray(r.tenants)||!r.tenants.length||r.tenants.length>100)throw Error();const root=dirname(resolve(path));keyBytes=await readFieldMaterial(root,fieldText(r.leaseSigningKeyFile,256),4096);const pem=new TextDecoder('utf-8',{fatal:true}).decode(keyBytes).replaceAll('\r\n','\n');if(!/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n?$/.test(pem))throw Error();const signingKey=createPrivateKey(pem);if(signingKey.asymmetricKeyType!=='ed25519')throw Error();const leaseKeyId=fieldLeaseKeyId(signingKey),tenants:FieldPlatformConfig['tenants']=new Map(),keyHashes=new Set<string>();let totalChannels=0,totalPoints=0;
  for(const rawTenant of r.tenants){const t=fieldObject(rawTenant,['tenantId','channels',...(fenced?['recoveryFile']:[])]),tenantId=fieldText(t.tenantId,80);if(!/^[A-Za-z0-9_-]+$/.test(tenantId)||tenants.has(tenantId)||!Array.isArray(t.channels)||t.channels.length>32)throw Error();const recovery=fenced?await recover(root,fieldText(t.recoveryFile,256),tenantId):undefined,channels=new Map<string,FieldPrivateChannel>(),publicChannels=[];
   for(const rawChannel of t.channels){const complete=(rawChannel as any)?.profile?.format==='idms-field-channel-public-profile-v2',c=fieldObject(rawChannel,['profile','requestKeyFile',...(complete?['eventKeyFile']:[])]),profile=parsePublicFieldProfile(c.profile);if(complete&&!fenced)throw Error();totalPoints+=profile.points.length;if(profile.source.tenantId!==tenantId||channels.has(profile.source.edgeId)||++totalChannels>128||totalPoints>4096)throw Error();const requestKey=await readFieldMaterial(root,fieldText(c.requestKeyFile,256),32);secrets.push(requestKey);if(requestKey.length!==32||requestKey.every(b=>b===0))throw Error();const requestKeySha256=fieldSha256(requestKey);if(keyHashes.has(requestKeySha256))throw Error();keyHashes.add(requestKeySha256);let eventKey:Buffer|undefined;if(complete){eventKey=await readFieldMaterial(root,fieldText(c.eventKeyFile,256),32);secrets.push(eventKey);const eventHash=fieldSha256(eventKey);if(eventKey.length!==32||eventKey.every(b=>b===0)||keyHashes.has(eventHash)||profile.transport?.eventKeySha256!==eventHash||profile.transport.acknowledgementKeyId!==leaseKeyId)throw Error();keyHashes.add(eventHash);}channels.set(profile.source.edgeId,{profile,requestKey,...(eventKey?{eventKey}:{})});publicChannels.push({profile,profileDigest:publicFieldProfileDigest(profile),requestKeySha256});
   }const snapshot=fieldRegistrySnapshot({format:fenced?'idms-field-registry-v2':'idms-field-registry-v1',tenantId,leaseKeyId,channels:publicChannels,...(recovery?{recovery:recovery.control.identity}:{})});freezeFieldValue(snapshot);tenants.set(tenantId,{snapshot,channels,...(recovery?{recovery}:{})});
  }return {signingKey,leaseKeyId,tenants};
 }catch{for(const s of secrets)s.fill(0);throw new DomainError(503,'现场私密注册或签发配置无效');}finally{keyBytes?.fill(0);}
}
// Material inspection produces no signing key, runtime handle or authorization.
// The recovery coordinator must separately hold its authority lock and verify the database.
export async function inspectFieldRecoveryRegistration(path:string,controlFile:string,expected:FieldRecoveryControl){
 let config:FieldPlatformConfig|undefined;
 try{
  const control=fieldRecoveryControl(expected);if(control.state!=='RESTORING'||!control.operationId||resolve(controlFile)!==controlFile||control.changedAtMs>Date.now())throw Error();
  let operationIntentSha256='';
  const recover:typeof loadFieldRecoveryHandle=async(root,name,tenant)=>{
   if(tenant!==control.tenantId||resolve(root,name)!==controlFile)throw Error();
   const actual=await readFieldMaterial(root,name,2048),marker=await readFieldMaterial(root,name+'.operation.lock',8192),main=fieldObject(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(marker)),['format','tenantId','operationId','kind','ownerHostId','authorityId','controlPathSha256','before','after','createdAtMs']);
   const before=fieldRecoveryControl(main.before);for(const key of ['ownerHostId','authorityId','controlPathSha256'])fieldHash(main[key]);
   if(main.format!=='idms-field-recovery-intent-v1'||main.kind!=='RESTORE'||main.operationId!==control.operationId||main.tenantId!==tenant||main.createdAtMs!==control.changedAtMs||stable(main.after)!==stable(control)||before.state!=='ACTIVE'||before.tenantId!==tenant||before.identity.deploymentId!==control.identity.deploymentId||before.identity.activationId!==control.previousActivationId||fieldSha256(process.platform==='win32'?controlFile.toLowerCase():controlFile)!==main.controlPathSha256||!marker.equals(Buffer.from(stable(main)))||!actual.equals(Buffer.from(stable(control))))throw Error();
   const intent=await readFieldMaterial(root,name+'.operations/'+control.operationId+'.intent.json',8192);if(!intent.equals(marker))throw Error();operationIntentSha256=fieldSha256(marker);return {root,name,control};
  };
  const bytes=await readBoundedFieldFile(path,2097152);config=await readPlatformConfig(path,recover);const tenant=config.tenants.get(control.tenantId);
  if(config.tenants.size!==1||!tenant?.recovery||tenant.snapshot.format!=='idms-field-registry-v2'||!tenant.snapshot.channels.length||tenant.snapshot.channels.some(c=>c.profile.format!=='idms-field-channel-public-profile-v2'||!c.profile.transport))throw Error();
  await recover(tenant.recovery.root,tenant.recovery.name,control.tenantId);if(!bytes.equals(await readBoundedFieldFile(path,2097152)))throw Error();
  const registry=JSON.parse(stable(tenant.snapshot)) as FieldRegistrySnapshot;
  return fieldRegistrationCandidate({format:'idms-field-recovery-registration-candidate-v1',tenantId:control.tenantId,operationId:control.operationId,controlSha256:fieldSha256(stable(control)),operationIntentSha256,configSha256:fieldSha256(bytes),registry,registrySha256:fieldSha256(stable(registry)),fieldEnabled:false,activationGranted:false});
 }catch{throw new DomainError(503,'现场恢复注册材料或操作围栏不可验证');}finally{if(config)clearFieldPlatformConfig(config);}
}
