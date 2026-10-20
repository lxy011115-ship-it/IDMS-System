import {OPCUAClient,MessageSecurityMode,SecurityPolicy,AttributeIds,TimestampsToReturn,UserTokenType,InMemoryCertificateKeyPairProvider,coerceNodeId,type ClientSession,type DataValue} from 'node-opcua';
import {makePrivateKeyFromPem} from 'node-opcua-crypto';
import {parseFieldProfile,fieldProfileDigest,fieldSha256,type FieldProfile} from './profile.ts';
import {verifyFieldMaterials,verifyFieldCertificate,fieldPeerLeaf,PinnedFieldCertificateStore,type FieldMaterials} from './certificates.ts';
import {readOnlyFieldServices,fieldEndpoint,verifyFieldSessionResponse,verifyFieldNamespace,verifyFieldNodeMetadata,fieldSamples} from './read-protocol.ts';
import {FieldChannelError,fieldFailure} from './error.ts';

export interface FieldReadPermit {profileDigest:string;phase:string}
export type FieldAuthorization=(permit:Readonly<FieldReadPermit>)=>void;
interface NodeRead {nodeId:string;attributeId:number}
interface Operation {client?:OPCUAClient;work:Promise<unknown>;cancel:(code:string)=>void;code:string|null;phase:string;expectedRead:NodeRead[]|null;quarantined:boolean;rpcInFlight:boolean}
export interface FieldReadObservation {
 format:'idms-field-read-observation-v1';ruleVersion:string;profileDigest:string;source:FieldProfile['source']&{origin:'FIELD'};startedAt:string;observedAt:string;
 channel:{securityMode:string;securityPolicy:string;server:ReturnType<typeof verifyFieldCertificate>;client:ReturnType<typeof verifyFieldCertificate>;endpointSha256:string;sessionIdentitySha256:string;requestServices:string[];namespaceBindings:ReturnType<typeof verifyFieldNamespace>;metadata:ReturnType<typeof verifyFieldNodeMetadata>};
 samples:ReturnType<typeof fieldSamples>;fieldCommissioned:false;trustEvidence:string;
}
export class PinnedFieldReadOnlyClient {
 #profile:Readonly<FieldProfile>;#materials:FieldMaterials;#authorize:FieldAuthorization;#digest:string;#active:Operation|null=null;#closed=false;#nonces=new Set<string>();
 constructor(profile:unknown,materials:FieldMaterials,authorize:FieldAuthorization){
  if(typeof authorize!=='function')fieldFailure('FIELD_AUTHORIZATION_REQUIRED');if(!materials||!Buffer.isBuffer(materials.serverCertificate)||!Buffer.isBuffer(materials.clientCertificate)||!Buffer.isBuffer(materials.privateKeyPem))fieldFailure('FIELD_MATERIAL_INVALID');this.#profile=parseFieldProfile(profile);this.#materials={serverCertificate:Buffer.from(materials.serverCertificate),clientCertificate:Buffer.from(materials.clientCertificate),privateKeyPem:Buffer.from(materials.privateKeyPem),...(materials.password!==undefined?{password:materials.password}:{})};verifyFieldMaterials(this.#profile,this.#materials);this.#authorize=authorize;this.#digest=fieldProfileDigest(this.#profile);
 }
 state(){return Object.freeze({profileDigest:this.#digest,active:!!this.#active,quarantined:this.#active?.quarantined||false,phase:this.#active?.phase||'IDLE',closed:this.#closed});}
 #guard(operation:Operation,phase:string){
  if(operation.code)fieldFailure(operation.code);if(this.#closed)fieldFailure('FIELD_CLIENT_CLOSED');operation.phase=phase;
  try{const returned:unknown=this.#authorize(Object.freeze({profileDigest:this.#digest,phase}));if(returned!==undefined){if(returned&&typeof (returned as Promise<unknown>).catch==='function')void (returned as Promise<unknown>).catch(()=>{});fieldFailure('FIELD_AUTHORIZATION_CONTRACT_INVALID');}}catch(e){if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_ADMISSION_DENIED');}
  verifyFieldMaterials(this.#profile,this.#materials);
 }
 #guardReadRequest(request:any,operation:Operation){
  const expected=operation.expectedRead;if(!expected||!Array.isArray(request.nodesToRead)||request.nodesToRead.length!==expected.length||request.maxAge!==0||request.timestampsToReturn!==TimestampsToReturn.Both)fieldFailure('FIELD_READ_SCOPE_VIOLATION');
  for(const [i,node]of request.nodesToRead.entries())if(coerceNodeId(node.nodeId).toString()!==coerceNodeId(expected[i].nodeId).toString()||node.attributeId!==expected[i].attributeId||node.indexRange&&!node.indexRange.isEmpty()||node.dataEncoding&&(node.dataEncoding.name||node.dataEncoding.namespaceIndex))fieldFailure('FIELD_READ_SCOPE_VIOLATION');
 }
 #installGuard(client:OPCUAClient,operation:Operation,clientCertificate:Buffer){
  // Bound to the locked library's transaction seam. Fail before connecting if
  // an upgrade removes it; never expose this raw client or session to callers.
  const rpc=client as unknown as {performMessageTransaction:(request:any,callback:(error:Error|null,response?:any)=>void)=>void};if(typeof rpc.performMessageTransaction!=='function')fieldFailure('FIELD_LIBRARY_CONTRACT_UNSUPPORTED');const original=rpc.performMessageTransaction.bind(client);
  rpc.performMessageTransaction=(request,callback)=>{
   let name:string;try{name=request?.schema?.name;if(!readOnlyFieldServices.includes(name))fieldFailure('FIELD_SERVICE_FORBIDDEN');if(name!=='CloseSessionRequest'){this.#guard(operation,'REQUEST:'+name);if(name==='ReadRequest')this.#guardReadRequest(request,operation);if(operation.rpcInFlight)fieldFailure('FIELD_REQUEST_BUSY');}operation.rpcInFlight=true;}catch(e){callback(e instanceof FieldChannelError?e:new FieldChannelError('FIELD_REQUEST_INVALID'));return;}
   let delivered=false;try{original(request,(error,response)=>{delivered=true;operation.rpcInFlight=false;let failure=error;try{
    if(!failure&&name!=='CloseSessionRequest'){this.#guard(operation,'RESPONSE:'+name);if(name==='CreateSessionRequest'&&response?.responseHeader?.serviceResult?.value===0)verifyFieldSessionResponse(request,response,this.#profile,clientCertificate,this.#nonces);if(name==='ReadRequest'&&response?.responseHeader?.serviceResult?.value===0&&(!Array.isArray(response.results)||response.results.length!==request.nodesToRead.length))fieldFailure('FIELD_SAMPLE_COUNT_MISMATCH');}
   }catch(e){failure=e instanceof FieldChannelError?e:new FieldChannelError('FIELD_RESPONSE_INVALID');}callback(failure||null,failure?undefined:response);});}catch(e){if(delivered)throw e;operation.rpcInFlight=false;callback(e instanceof FieldChannelError?e:new FieldChannelError('FIELD_REQUEST_INVALID'));}
  };
 }
 async #read(session:ClientSession,operation:Operation,nodes:NodeRead[]){operation.expectedRead=nodes;try{const values=await session.read(nodes,0);this.#guard(operation,'AFTER_READ');return values as DataValue[];}finally{operation.expectedRead=null;}}
 async #performRead(operation:Operation):Promise<FieldReadObservation>{
  const startedAt=new Date().toISOString();this.#guard(operation,'CONNECT');const p=this.#profile,material=verifyFieldMaterials(p,this.#materials),store=new PinnedFieldCertificateStore(p),provider=new InMemoryCertificateKeyPairProvider([material.clientCertificate],makePrivateKeyFromPem(this.#materials.privateKeyPem.toString('utf8')));let session:ClientSession|undefined;
  const client=OPCUAClient.create({applicationUri:p.opcua.clientApplicationUri,clientName:'IDMS pinned read-only field channel',certificateKeyPairProvider:provider,clientCertificateManager:store,serverCertificate:material.serverCertificate,endpointMustExist:true,securityMode:MessageSecurityMode.SignAndEncrypt,securityPolicy:SecurityPolicy[p.opcua.securityPolicy],connectionStrategy:{maxRetry:0,initialDelay:0,maxDelay:0},keepSessionAlive:false,keepPendingSessionsOnDisconnect:false,requestedSessionTimeout:Math.min(30000,p.limits.timeoutMs*2),transportTimeout:p.limits.timeoutMs,defaultTransactionTimeout:p.limits.timeoutMs,transportSettings:{maxMessageSize:1048576,maxChunkCount:64,receiveBufferSize:65536,sendBufferSize:65536}});
  operation.client=client;this.#installGuard(client,operation,material.clientCertificate);
  try{
   await client.connect(p.opcua.endpoint);this.#guard(operation,'ENDPOINT');verifyFieldCertificate(fieldPeerLeaf(client.serverCertificate!),p,'SERVER');fieldEndpoint(await client.getEndpoints(),p);this.#guard(operation,'CREATE_SESSION');
   session=await client.createSession(p.userIdentity.type==='Anonymous'?{type:UserTokenType.Anonymous}:{type:UserTokenType.UserName,userName:p.userIdentity.userName,password:this.#materials.password!});this.#guard(operation,'SESSION_READY');verifyFieldCertificate(fieldPeerLeaf(session.serverCertificate),p,'SERVER');
   const namespaces=await this.#read(session,operation,[{nodeId:'ns=0;i=2255',attributeId:AttributeIds.Value}]),namespaceBindings=verifyFieldNamespace(namespaces[0],p);
   const metadataNodes=p.points.flatMap(point=>[AttributeIds.DataType,AttributeIds.ValueRank,AttributeIds.AccessLevel,AttributeIds.UserAccessLevel].map(attributeId=>({nodeId:point.nodeId,attributeId}))),metadata=verifyFieldNodeMetadata(await this.#read(session,operation,metadataNodes),p);
   const values=await this.#read(session,operation,p.points.map(point=>({nodeId:point.nodeId,attributeId:AttributeIds.Value})));this.#guard(operation,'RESULT');const observedAt=new Date().toISOString(),samples=fieldSamples(values,p,Date.parse(observedAt)),result={format:'idms-field-read-observation-v1' as const,ruleVersion:'pinned-read-only-opcua-1.0.0',profileDigest:this.#digest,source:{...p.source,origin:'FIELD' as const},startedAt,observedAt,channel:{securityMode:p.opcua.securityMode,securityPolicy:p.opcua.securityPolicy,server:material.server,client:material.client,endpointSha256:fieldSha256(p.opcua.endpoint),sessionIdentitySha256:fieldSha256(session.sessionId.toString()),requestServices:[...readOnlyFieldServices],namespaceBindings,metadata},samples,fieldCommissioned:false as const,trustEvidence:'GATEWAY_OBSERVED_PINNED_LEAF_READ_NOT_EXTERNAL_DEVICE_ATTESTATION'};this.#guard(operation,'RETURN_RESULT');return result;
  }finally{
   operation.phase='DRAINING';try{await session?.close();}catch{}try{await client.disconnect();}catch{}await store.dispose();operation.client=undefined;
  }
 }
 async readOnce(options:{signal?:AbortSignal}={}):Promise<FieldReadObservation>{
  if(this.#closed)fieldFailure('FIELD_CLIENT_CLOSED');if(this.#active)fieldFailure(this.#active.quarantined?'FIELD_READ_QUARANTINED':'FIELD_READ_BUSY');let rejectCancel!:(e:Error)=>void;
  const cancelled=new Promise<never>((_,reject)=>rejectCancel=reject),operation:Operation={work:Promise.resolve(),code:null,phase:'ADMITTED',expectedRead:null,quarantined:false,rpcInFlight:false,cancel:code=>{if(operation.code)return;operation.code=code;rejectCancel(new FieldChannelError(code));void operation.client?.disconnect().catch(()=>{});}};this.#active=operation;
  const externalAbort=()=>operation.cancel('FIELD_READ_CANCELLED');options.signal?.addEventListener('abort',externalAbort,{once:true});if(options.signal?.aborted)externalAbort();const timer=setTimeout(()=>operation.cancel('FIELD_READ_TIMEOUT'),this.#profile.limits.timeoutMs);
  const work=Promise.resolve().then(()=>this.#performRead(operation));operation.work=work;const terminal=work.then(()=>{},()=>{}).finally(()=>{if(this.#active===operation)this.#active=null;operation.quarantined=false;});
  try{const result=await Promise.race([work,cancelled]);this.#guard(operation,'AFTER_DRAIN');return result;}catch(e){
   if(operation.code){let cleanupTimer:ReturnType<typeof setTimeout>|undefined;const drained=await Promise.race([terminal.then(()=>true),new Promise<false>(ok=>{cleanupTimer=setTimeout(()=>ok(false),this.#profile.limits.cleanupTimeoutMs);})]);clearTimeout(cleanupTimer);if(!drained){operation.quarantined=true;throw new FieldChannelError(operation.code+'_IN_FLIGHT');}throw new FieldChannelError(operation.code);}
   if(e instanceof FieldChannelError)throw e;throw new FieldChannelError('FIELD_OPCUA_READ_FAILED');
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',externalAbort);}
 }
 async close(){this.#closed=true;const operation=this.#active;if(operation){operation.cancel('FIELD_READ_CANCELLED');await operation.work.catch(()=>{});}this.#materials.privateKeyPem.fill(0);this.#materials.password=undefined;}
}
