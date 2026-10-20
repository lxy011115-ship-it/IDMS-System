import {verify,constants} from 'node:crypto';
import {X509Certificate} from 'node:crypto';
import {MessageSecurityMode,SecurityPolicy,DataType,VariantArrayType,coerceNodeId,type DataValue} from 'node-opcua';
import {type FieldProfile,type FieldPoint,fieldSha256} from './profile.ts';
import {verifyFieldCertificate,fieldPeerLeaf} from './certificates.ts';
import {fieldFailure} from './error.ts';

export const readOnlyFieldServices:readonly string[]=Object.freeze(['GetEndpointsRequest','CreateSessionRequest','ActivateSessionRequest','CloseSessionRequest','ReadRequest']);
export function fieldEndpoint(endpoints:any[],p:Readonly<FieldProfile>,now=Date.now(),sessionCertificate?:Buffer){
 if(!Array.isArray(endpoints)||!endpoints.length||endpoints.length>64)fieldFailure('FIELD_ENDPOINT_MISMATCH');const matching=endpoints.filter(e=>e.endpointUrl===p.opcua.endpoint&&e.securityMode===MessageSecurityMode.SignAndEncrypt&&e.securityPolicyUri===SecurityPolicy[p.opcua.securityPolicy]);if(matching.length!==1)fieldFailure('FIELD_ENDPOINT_MISMATCH');const e=matching[0];if(e.server?.applicationUri!==p.opcua.serverApplicationUri||![0,2].includes(e.server?.applicationType)||e.transportProfileUri!=='http://opcfoundation.org/UA-Profile/Transport/uatcp-uasc-uabinary')fieldFailure('FIELD_ENDPOINT_MISMATCH');
 // CreateSession may omit the repeated endpoint certificate. Its separate
 // serverCertificate must already have passed the same exact leaf check.
 const certificate=e.serverCertificate?.length?e.serverCertificate:sessionCertificate;verifyFieldCertificate(fieldPeerLeaf(certificate!),p,'SERVER',now);return e;
}
export function verifyFieldSessionResponse(request:any,response:any,p:Readonly<FieldProfile>,clientCertificate:Buffer,seenNonces:Set<string>,now=Date.now()){
 const leaf=fieldPeerLeaf(response.serverCertificate);verifyFieldCertificate(leaf,p,'SERVER',now);fieldEndpoint(response.serverEndpoints,p,now,leaf);
 if(!Buffer.isBuffer(request.clientCertificate)||!Buffer.isBuffer(request.clientNonce)||request.clientNonce.length<32||request.clientNonce.length>64||!Buffer.isBuffer(response.serverNonce)||response.serverNonce.length<32||response.serverNonce.length>64||response.serverNonce.every((b:number)=>b===0)||request.clientNonce.equals(response.serverNonce)||!request.clientCertificate.equals(clientCertificate))fieldFailure('FIELD_SESSION_NONCE_INVALID');
 const nonceDigest=fieldSha256(response.serverNonce);if(seenNonces.has(nonceDigest))fieldFailure('FIELD_SESSION_NONCE_REUSED');
 const pss=p.opcua.securityPolicy==='Aes256_Sha256_RsaPss',expected=pss?'http://opcfoundation.org/UA/security/rsa-pss-sha2-256':'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',sig=response.serverSignature;
 if(sig?.algorithm!==expected||!Buffer.isBuffer(sig.signature)||sig.signature.length<256||sig.signature.length>512)fieldFailure('FIELD_SESSION_SIGNATURE_INVALID');
 const valid=verify('sha256',Buffer.concat([request.clientCertificate,request.clientNonce]),{key:new X509Certificate(leaf).publicKey,padding:pss?constants.RSA_PKCS1_PSS_PADDING:constants.RSA_PKCS1_PADDING,...(pss?{saltLength:32}:{})},sig.signature);if(!valid)fieldFailure('FIELD_SESSION_SIGNATURE_INVALID');seenNonces.add(nonceDigest);if(seenNonces.size>128)seenNonces.delete(seenNonces.values().next().value!);
}
function good(v:DataValue){return v?.statusCode&&Number.isSafeInteger(v.statusCode.value)&&(v.statusCode.value>>>30)===0;}
export function verifyFieldNamespace(value:DataValue,p:Readonly<FieldProfile>){
 const ns=value?.value;if(!good(value)||ns?.dataType!==DataType.String||ns.arrayType!==VariantArrayType.Array||!Array.isArray(ns.value)||!ns.value.length||ns.value.length>256||ns.value[0]!=='http://opcfoundation.org/UA/'||ns.value.some((s:unknown)=>typeof s!=='string'||s.length>512)||new Set(ns.value).size!==ns.value.length)fieldFailure('FIELD_NAMESPACE_MISMATCH');
 const used=new Map<number,string>();for(const point of p.points){const index=coerceNodeId(point.nodeId).namespace;if(ns.value[index]!==point.namespaceUri)fieldFailure('FIELD_NAMESPACE_MISMATCH');used.set(index,point.namespaceUri);}return [...used].sort(([a],[b])=>a-b).map(([index,namespaceUri])=>({index,namespaceUri}));
}
export function verifyFieldNodeMetadata(values:DataValue[],p:Readonly<FieldProfile>){
 if(!Array.isArray(values)||values.length!==p.points.length*4)fieldFailure('FIELD_METADATA_MISMATCH');return p.points.map((point,i)=>{
  const [type,rank,access,userAccess]=values.slice(i*4,i*4+4);if(![type,rank,access,userAccess].every(v=>good(v)&&v.value?.arrayType===VariantArrayType.Scalar)||type.value.dataType!==DataType.NodeId||rank.value.dataType!==DataType.Int32||access.value.dataType!==DataType.Byte||userAccess.value.dataType!==DataType.Byte||type.value.value?.toString()!==coerceNodeId(DataType[point.dataType]).toString()||rank.value.value!==-1)fieldFailure('FIELD_METADATA_MISMATCH');
  const a=access.value.value,u=userAccess.value.value;if(!Number.isSafeInteger(a)||a<0||a>255||!Number.isSafeInteger(u)||u<0||u>255||!(a&1)||!(u&1)||(u&2)!==0)fieldFailure('FIELD_NODE_NOT_READ_ONLY');return {tagCode:point.tagCode,nodeId:point.nodeId,dataType:point.dataType,valueRank:-1,accessLevel:a,userAccessLevel:u};
 });
}
const ranges:Record<string,[number,number]>={SByte:[-128,127],Byte:[0,255],Int16:[-32768,32767],UInt16:[0,65535],Int32:[-2147483648,2147483647],UInt32:[0,4294967295]};
function numeric(point:FieldPoint,v:DataValue,quality:string){
 const variant=v.value;if(variant?.arrayType!==VariantArrayType.Scalar)fieldFailure('FIELD_SAMPLE_TYPE_MISMATCH');if(variant.dataType===DataType.Null&&variant.value===null&&quality!=='GOOD')return null;if(variant.dataType!==DataType[point.dataType])fieldFailure('FIELD_SAMPLE_TYPE_MISMATCH');let raw=variant.value;
 if(point.dataType==='Int64'||point.dataType==='UInt64'){if(!Array.isArray(raw)||raw.length!==2||raw.some(n=>!Number.isSafeInteger(n)||n<0||n>4294967295))fieldFailure('FIELD_SAMPLE_TYPE_MISMATCH');const value=(BigInt(raw[0])<<32n)|BigInt(raw[1]),integer=point.dataType==='Int64'?BigInt.asIntN(64,value):value;if(integer>BigInt(Number.MAX_SAFE_INTEGER)||integer<BigInt(Number.MIN_SAFE_INTEGER))fieldFailure('FIELD_INTEGER_PRECISION_UNSAFE');raw=Number(integer);}
 if(typeof raw!=='number'||!Number.isFinite(raw))fieldFailure('FIELD_SAMPLE_VALUE_INVALID');const range=ranges[point.dataType];if(range&&(!Number.isInteger(raw)||raw<range[0]||raw>range[1]))fieldFailure('FIELD_SAMPLE_VALUE_INVALID');if(quality==='GOOD'&&(raw<point.minimum||raw>point.maximum))fieldFailure('FIELD_SAMPLE_RANGE_INVALID');return raw as number;
}
export function fieldSamples(values:DataValue[],p:Readonly<FieldProfile>,now:number){
 if(!Array.isArray(values)||values.length!==p.points.length||!Number.isFinite(now))fieldFailure('FIELD_SAMPLE_COUNT_MISMATCH');return p.points.map((point,i)=>{const v=values[i];if(!v||!Number.isSafeInteger(v.statusCode?.value)||v.statusCode.value<0||v.statusCode.value>4294967295||!(v.sourceTimestamp instanceof Date)||!Number.isFinite(v.sourceTimestamp.getTime()))fieldFailure('FIELD_SAMPLE_TIMESTAMP_INVALID');const time=v.sourceTimestamp.getTime();if(time>now+p.limits.maxFutureSkewMs||time<now-p.limits.maxSampleAgeMs)fieldFailure('FIELD_SAMPLE_TIMESTAMP_INVALID');const severity=v.statusCode.value>>>30,quality=severity===0?'GOOD' as const:severity===1?'UNCERTAIN' as const:'BAD' as const,value=numeric(point,v,quality),ps=v.sourcePicoseconds||0;if(!Number.isSafeInteger(ps)||ps<0||ps>999999999)fieldFailure('FIELD_SAMPLE_TIMESTAMP_INVALID');return {tagCode:point.tagCode,nodeId:point.nodeId,unit:point.unit,value,quality,eventTime:v.sourceTimestamp.toISOString(),sourcePicoseconds:ps,rawStatusCode:v.statusCode.value,rawDataType:DataType[v.value.dataType]};});
}
