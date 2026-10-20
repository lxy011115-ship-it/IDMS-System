import {randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import {DomainError} from './service.ts';
import {loadFieldPlatformConfig,clearFieldPlatformConfig,type FieldPlatformConfig} from './field-config.ts';
import {appendFieldRegistryObservation} from './field-registry.ts';
import {prepareFieldLeaseIssuance} from './field-lease-issue.ts';
import {verifyFieldLeaseRequest} from '../integrations/field-request.ts';
import {signFieldLease,verifyFieldLease,type SignedFieldLease} from '../integrations/field-lease.ts';
import {createPublicKey} from 'node:crypto';
import {publicFieldProfileDigest} from '../integrations/field-profile.ts';
import {mutate,consistentRead} from './import-api.ts';
import {verifyFieldCheckRequest,signFieldCheck,verifyFieldCheck,type SignedFieldCheck} from '../integrations/field-check.ts';
import {fieldCurrentLeaseCheck} from './field-current-check.ts';
import {readFieldCheckAudits} from './field-check-read.ts';
import {storageMode,tenantPool} from './postgres-repository.ts';
import {validateRuntimeConfig,verifyDatabaseSecurity} from './postgres-security.ts';
import {verifyFieldModule,type FieldDatabaseIdentity} from './field-schema-check.ts';
import {assertFieldRecoveryDatabase,verifyFieldRecoveryHandle,fieldRecoveryUnavailable} from './field-recovery-read.ts';
import {FieldIntakeOwner} from './field-intake-owner.ts';
import {FieldReceiveTransactions} from './field-receive-transaction.ts';
import {fieldEventMaxBytes,fieldAckForEvent,signFieldAck,verifyFieldAck,type SignedFieldAck} from '../integrations/field-event.ts';
import {FieldChannelError} from '../services/field/error.ts';
import {bindRequestTenant} from './request-capacity.ts';
import {requestSignal,CapacityError,resident,estimatedBytes} from './capacity.ts';
const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'现场签发请求已取消','REQUEST_CANCELLED');};
export class FieldPlatformService {
 #config:FieldPlatformConfig|undefined;#started=false;#closing=false;#active=new Set<Promise<unknown>>();#account:ReturnType<typeof resident.account>|undefined;readonly #receivers=new FieldReceiveTransactions();#databases=new Map<string,FieldDatabaseIdentity>();#enabling=false;readonly #owners=new Map<string,FieldIntakeOwner>();readonly #retired=new Set<string>();
 readonly instanceId='field-registry-'+randomUUID();
 get receiving(){return this.configured&&this.#databases.size>0;}
 get configured(){return !!this.#config&&!this.#closing;}
 publicSnapshot(tenant:string){return this.configured&&this.#config?.tenants.has(tenant)?structuredClone(this.#config.tenants.get(tenant)!.snapshot):null;}
 async verifyRecoveryCurrent(tenant:string){await verifyFieldRecoveryHandle(this.#config?.tenants.get(tenant)?.recovery);}
 async retireReceiving(tenant:string){this.#retired.add(tenant);await this.#owners.get(tenant)?.close();}
 async start(store:Store,path=process.env.IDMS_FIELD_PLATFORM_CONFIG){
  if(this.#started||this.#closing)throw new DomainError(503,'现场签发服务不能重复启动');this.#started=true;if(!path)return;if(storageMode!=='postgres-tenant-databases')throw new DomainError(503,'现场签发需要独立企业PostgreSQL');const config=await loadFieldPlatformConfig(path),account=resident.account('bootstrap');
  try{for(const [tenant,t]of config.tenants){if(!store.tenants.some(v=>v.id===tenant&&v.status==='ACTIVE'))throw new DomainError(503,'现场注册企业无效');account.grow(estimatedBytes(t.snapshot)+(t.recovery?estimatedBytes(t.recovery):0)+[...t.channels.values()].reduce((n,c)=>n+c.requestKey.length+(c.eventKey?.length||0),0));if(t.recovery){const p=tenantPool(tenant).options;assertFieldRecoveryDatabase(t.recovery,{host:String(p.host),port:Number(p.port),database:String(p.database),user:String(p.user)});await verifyFieldRecoveryHandle(t.recovery);}await mutate(store,async(_client,w)=>{await verifyFieldRecoveryHandle(t.recovery);return appendFieldRegistryObservation(w.store,t.snapshot,this.instanceId);},tenant);await verifyFieldRecoveryHandle(t.recovery);}this.#config=config;this.#account=account;}catch(e){clearFieldPlatformConfig(config);account.release();throw e;}
 }
 async enableReceiving(rawRuntime:unknown){if(this.#enabling||!this.#config||this.#closing||this.#databases.size)throw new DomainError(503,'现场接收未配置或重复启动');this.#enabling=true;const work=Promise.resolve().then(()=>this.#enableReceiving(rawRuntime));this.#active.add(work);try{await work;}catch(e){await Promise.allSettled([...this.#owners.values()].map(o=>o.close()));this.#owners.clear();this.#databases.clear();throw e;}finally{this.#active.delete(work);this.#enabling=false;}}
 async #enableReceiving(rawRuntime:unknown){
  if(!this.#config||this.#closing||this.#databases.size)throw new DomainError(503,'现场接收未配置或重复启动');const runtime=validateRuntimeConfig(rawRuntime),bindings=new Map<string,FieldDatabaseIdentity>();
  for(const [tenant,t]of this.#config.tenants){if(![...t.channels.values()].some(c=>!!c.profile.transport))continue;if(!t.recovery||t.snapshot.format!=='idms-field-registry-v2')throw fieldRecoveryUnavailable();await verifyFieldRecoveryHandle(t.recovery);const a=runtime.tenants[tenant],pool=tenantPool(tenant);if(!a||pool.options.host!==runtime.host||Number(pool.options.port)!==runtime.port||pool.options.database!==a.database||pool.options.user!==a.user)throw new DomainError(503,'现场接收数据库绑定不一致');const client=await pool.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verifyDatabaseSecurity(client,a,tenant);await verifyFieldModule(client,a,tenant);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}const {password:_,...identity}=a;bindings.set(tenant,Object.freeze(identity));}
  if(!bindings.size)throw new DomainError(503,'现场接收需要完整v2配置');if(this.#closing)throw new DomainError(503,'现场接收正在排空');this.#databases=bindings;for(const tenant of bindings.keys()){const owner=new FieldIntakeOwner(tenantPool(tenant),tenant);this.#owners.set(tenant,owner);await owner.acquire();}
 }
 ownsReceiving(tenant:string){return this.receiving&&!this.#retired.has(tenant)&&!!this.#owners.get(tenant)?.held;}
 async acquireReceivingOwnership(tenant:string){if(!this.receiving||this.#closing||this.#retired.has(tenant))return false;return await this.#owners.get(tenant)?.acquire()||false;}
 async receiveMqtt(topic:string,bytes:Uint8Array,signal?:AbortSignal):Promise<SignedFieldAck|null>{
  if(!this.#config||this.#closing||!this.receiving)throw new DomainError(503,'现场接收尚未启用');if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>fieldEventMaxBytes)return null;const config=this.#config;let selected;for(const [tenant,t]of config.tenants)for(const channel of t.channels.values())if(channel.profile.transport?.topics.telemetry===topic)selected={tenant,t,channel};if(!selected||!selected.channel.eventKey)return null;const {tenant,t,channel}=selected,database=this.#databases.get(tenant);if(!database)return null;const owner=this.#owners.get(tenant);if(!owner||!this.ownsReceiving(tenant))throw new DomainError(503,'当前实例不是现场接收所有者');const account=resident.account('body');let payload:Buffer|undefined;
  try{account.grow(bytes.byteLength*8+65536);payload=Buffer.from(bytes);const work=Promise.resolve().then(async()=>{if(this.#closing||signal?.aborted)throw new DomainError(503,'现场接收正在排空');return this.#receivers.receive(payload!,{profile:channel.profile,snapshot:t.snapshot,publicKey:createPublicKey(config.signingKey),eventKey:channel.eventKey!,database,owner,recovery:t.recovery},signal);});this.#active.add(work);try{const received=await work;if(this.#closing||signal?.aborted)throw new DomainError(503,'现场接收正在排空');await verifyFieldRecoveryHandle(t.recovery);check();const c=received.candidate,now=Date.now(),ack=signFieldAck(fieldAckForEvent(received.event,c.status,c.reason,c.pointId,c.receiptAuditId,c.receiptAt,now),config.signingKey);verifyFieldAck(ack,createPublicKey(config.signingKey),received.event,now);return ack;}catch(e){if(['FIELD_REGISTRY_STALE','FIELD_RECOVERY_FENCE_STALE'].includes((e as any)?.code)){this.#retired.add(tenant);await owner.close();}if(e instanceof FieldChannelError&&['FIELD_EVENT_INVALID','FIELD_MESSAGE_INVALID'].includes(e.code))return null;throw e;}finally{this.#active.delete(work);}
  }finally{payload?.fill(0);account.release();}
 }
 async issue(store:Store,raw:unknown):Promise<SignedFieldLease>{
  if(!this.#config||this.#closing)throw new DomainError(503,'现场签发未配置或正在排空');const config=this.#config;const task=this.#issue(store,config,raw);this.#active.add(task);try{return await task;}finally{this.#active.delete(task);}
 }
 async #issue(store:Store,config:FieldPlatformConfig,raw:unknown){
  check();let request,tenant,channel;try{const r=raw as Record<string,unknown>;tenant=config.tenants.get(typeof r?.tenantId==='string'?r.tenantId:'');channel=tenant?.channels.get(typeof r?.edgeId==='string'?r.edgeId:'');if(!tenant||!channel)throw Error();request=verifyFieldLeaseRequest(raw,channel.requestKey,Date.now());if(request.deviceCode!==channel.profile.source.deviceCode||request.mapVersion!==channel.profile.source.mapVersion||request.profileDigest!==publicFieldProfileDigest(channel.profile))throw Error();}catch{throw new DomainError(401,'现场签发请求认证失败');}
  bindRequestTenant(request.tenantId);const authenticated=request,snapshot=tenant.snapshot,key=channel.requestKey;
  await verifyFieldRecoveryHandle(tenant.recovery);const body=await mutate(store,async(_client,w)=>{check();await verifyFieldRecoveryHandle(tenant.recovery);try{verifyFieldLeaseRequest(authenticated,key,Date.now());}catch{throw new DomainError(401,'现场签发请求已失效');}return prepareFieldLeaseIssuance(w.store,w.imports,authenticated,snapshot);},authenticated.tenantId);
  // mutate resolves only after COMMIT. No signature is produced or returned
  // on a failed/ambiguous transaction; a retry rechecks current state first.
  await verifyFieldRecoveryHandle(tenant.recovery);check();const now=Date.now();if(now<body.issuedAtMs)throw new DomainError(503,'FIELD_LEASE_CLOCK_INVALID');if(now>=body.expiresAtMs)throw new DomainError(409,'FIELD_LEASE_EXPIRED');const lease=signFieldLease(body,config.signingKey);verifyFieldLease(lease,createPublicKey(config.signingKey),{...channel.profile.source,profileDigest:authenticated.profileDigest,requestId:authenticated.requestId},now);return lease;
 }
 async checkCurrent(store:Store,raw:unknown):Promise<SignedFieldCheck>{
  if(!this.#config||this.#closing)throw new DomainError(503,'现场核对未配置或正在排空');const task=this.#checkCurrent(store,this.#config,raw);this.#active.add(task);try{return await task;}finally{this.#active.delete(task);}
 }
 async #checkCurrent(store:Store,config:FieldPlatformConfig,raw:unknown){
  check();let request,tenant,channel;try{const lease=(raw as any)?.lease?.body;tenant=config.tenants.get(typeof lease?.tenantId==='string'?lease.tenantId:'');channel=tenant?.channels.get(typeof lease?.edgeId==='string'?lease.edgeId:'');if(!tenant||!channel)throw Error();request=verifyFieldCheckRequest(raw,channel.requestKey,Date.now());if(request.lease.body.profileDigest!==publicFieldProfileDigest(channel.profile))throw Error();}catch{throw new DomainError(401,'现场核对请求认证失败');}
  bindRequestTenant(request.lease.body.tenantId);const authenticated=request,snapshot=tenant.snapshot,key=channel.requestKey,publicKey=createPublicKey(config.signingKey);
  await verifyFieldRecoveryHandle(tenant.recovery);const body=await consistentRead(store,authenticated.lease.body.tenantId,async w=>{check();await verifyFieldRecoveryHandle(tenant.recovery);try{verifyFieldCheckRequest(authenticated,key,Date.now());}catch{throw new DomainError(401,'现场核对请求已失效');}const audits=await readFieldCheckAudits(w,authenticated.lease.body.tenantId,authenticated.lease.body.edgeId);check();return fieldCurrentLeaseCheck({...w.store,audits},w.imports,authenticated,snapshot,publicKey,Date.now());});
  await verifyFieldRecoveryHandle(tenant.recovery);check();const result=signFieldCheck(body,config.signingKey);verifyFieldCheck(result,publicKey,{requestId:authenticated.requestId,requestedAtMs:authenticated.requestedAtMs,lease:authenticated.lease},Date.now());return result;
 }
 async close(){this.#closing=true;await this.#receivers.close();await Promise.allSettled([...this.#active]);await Promise.allSettled([...this.#owners.values()].map(o=>o.close()));this.#owners.clear();if(this.#config)clearFieldPlatformConfig(this.#config);this.#config=undefined;this.#databases.clear();this.#account?.release();this.#account=undefined;}
}
