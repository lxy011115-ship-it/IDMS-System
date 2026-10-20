import tls from 'node:tls';
import {isIP} from 'node:net';
import {X509Certificate} from 'node:crypto';
import {verifyFieldMqttMaterials,fieldBrokerUrl,completeFieldMqttProfile} from '../services/field/mqtt-materials.ts';
import {fieldSha256,publicFieldProfileDigest} from '../integrations/field-profile.ts';
import {ActivationTlsStream} from './field-activation-tls-stream.mjs';
const failure=code=>Object.assign(Error(code),{code});

// No MQTT CONNECT, client ID, subscription or application byte is sent. A
// broker may replace the client ID with the certificate CN, so even a random
// MQTT client ID would risk displacing a live source.
async function handshake(profile,url,role,materials,{signal,authorize,omitCertificate=false,ceiling}={}){
 if(typeof authorize!=='function')throw failure('FIELD_ACTIVATION_PEER_AUTHORIZATION_REQUIRED');
 const p=completeFieldMqttProfile(profile),u=fieldBrokerUrl(url,p),checked=verifyFieldMqttMaterials(p,url,role,materials);
 const permit=phase=>{if(signal?.aborted)throw failure('FIELD_ACTIVATION_PEER_CANCELLED');const value=authorize(Object.freeze({phase,role,profileDigest:publicFieldProfileDigest(p)}));if(value!==undefined){if(value&&typeof value.then==='function')void Promise.resolve(value).catch(()=>{});throw failure('FIELD_ACTIVATION_PEER_AUTHORIZATION_INVALID');}};permit('CONNECT');
 let socket,transport,closed,timer,abort,secure=false,ticket=false,settled=false,protocol,resolve,reject;
 const result=new Promise((ok,no)=>{resolve=ok;reject=no;});
 const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);socket?.destroy();};
 const confirm=()=>{if(!secure||settled)return;try{
  permit('CONNECTED');if(protocol!=='TLSv1.2'&&protocol!=='TLSv1.3')throw failure('FIELD_ACTIVATION_TLS_PROTOCOL_INVALID');
  // TLS 1.2 server Finished follows client-certificate verification. In 1.3
  // secureConnect alone precedes that proof; a post-handshake server ticket
  // is required. A 1.3 peer with tickets disabled is explicitly unproven.
  if(protocol==='TLSv1.3'&&!ticket)return;
  if(protocol==='TLSv1.2'&&!omitCertificate&&transport.state.tls12ClientCertificateSha256!==(role==='EDGE'?p.transport.edgeCertificateSha256:p.transport.platformCertificateSha256))throw failure('FIELD_ACTIVATION_TLS_CLIENT_AUTH_UNPROVEN');
  if(!transport.state.clientHellosVerified||transport.state.selectedProtocol!==protocol)throw failure('FIELD_ACTIVATION_TLS_HELLO_UNSUPPORTED');finish(null,{format:'idms-field-activation-tls-peer-v1',role,protocol,serverCertificateSha256:p.transport.serverCertificateSha256,clientCertificateSha256:role==='EDGE'?p.transport.edgeCertificateSha256:p.transport.platformCertificateSha256,clientCertificateAcceptedEvidence:protocol==='TLSv1.2'?'TLS12_SERVER_FINISHED':'TLS13_POST_HANDSHAKE_TICKET',clientHelloEarlyTicketRequestBlocked:true,applicationBytesSent:0,applicationBytesReceived:0,mqttClientCreated:false,normalClientIdentifierUsed:false,brokerTopicAclVerified:false});
 }catch(e){finish(e);}};
 try{
  transport=new ActivationTlsStream(checked.host,Number(u.port));socket=tls.connect({socket:transport,host:checked.host,...(isIP(checked.host)?{}:{servername:checked.host}),minVersion:'TLSv1.2',...(ceiling?{maxVersion:ceiling}:{}),rejectUnauthorized:true,ca:checked.caCertificate,...(omitCertificate?{}:{cert:checked.clientCertificate,key:materials.privateKeyPem}),checkServerIdentity:(host,certificate)=>{
   const e=tls.checkServerIdentity(host,certificate);if(e)return e;try{if(fieldSha256(new X509Certificate(certificate.raw).raw)!==p.transport.serverCertificateSha256)return failure('FIELD_ACTIVATION_TLS_PEER_PIN_MISMATCH');verifyFieldMqttMaterials(p,url,role,materials);permit('PEER');return undefined;}catch{return failure('FIELD_ACTIVATION_TLS_PEER_INVALID');}
  }});
  closed=socket.closed?Promise.resolve():new Promise(ok=>socket.once('close',ok));
  socket.on('error',e=>finish(Object.assign(failure(omitCertificate&&(e.code==='ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED'||['ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE','ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE'].includes(e.code)&&transport.state.tls12EmptyClientCertificate)?'FIELD_ACTIVATION_TLS_CERTIFICATE_REQUIRED_PROVEN':'FIELD_ACTIVATION_TLS_HANDSHAKE_FAILED'),{nativeCode:e.code})));
  socket.once('close',()=>finish(failure('FIELD_ACTIVATION_TLS_PEER_CLOSED')));
  socket.on('data',()=>finish(failure('FIELD_ACTIVATION_TLS_APPLICATION_DATA_UNEXPECTED')));
  socket.on('session',session=>{if(Buffer.isBuffer(session)&&session.length>0&&session.length<=65536)ticket=true;session?.fill?.(0);confirm();});
  socket.once('secureConnect',()=>{try{if(!socket.authorized||socket.isSessionReused())throw failure('FIELD_ACTIVATION_TLS_FRESH_AUTHENTICATION_REQUIRED');const peer=socket.getPeerCertificate(true);if(!peer?.raw||fieldSha256(peer.raw)!==p.transport.serverCertificateSha256)throw failure('FIELD_ACTIVATION_TLS_PEER_PIN_MISMATCH');verifyFieldMqttMaterials(p,url,role,materials);protocol=socket.getProtocol();secure=true;confirm();}catch(e){finish(e);}});
  abort=()=>finish(failure('FIELD_ACTIVATION_PEER_CANCELLED'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  timer=setTimeout(()=>finish(failure(secure&&protocol==='TLSv1.3'?'FIELD_ACTIVATION_TLS13_CLIENT_AUTH_UNPROVEN':'FIELD_ACTIVATION_TLS_HANDSHAKE_TIMEOUT')),3000);
  return await result;
 }finally{clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);socket?.destroy();transport?.destroy();await closed;await transport?.terminal();}
}
export async function inspectFieldMqttTlsPeer(profile,url,role,materials,options={}){
 let accepted;try{accepted=await handshake(profile,url,role,materials,options);}catch(e){if(e.code!=='FIELD_ACTIVATION_TLS13_CLIENT_AUTH_UNPROVEN')throw e;try{accepted=await handshake(profile,url,role,materials,{...options,ceiling:'TLSv1.2'});}catch{throw e;}}
 let required=false;try{await handshake(profile,url,role,materials,{...options,ceiling:accepted.protocol,omitCertificate:true});}catch(e){if(e.code!=='FIELD_ACTIVATION_TLS_CERTIFICATE_REQUIRED_PROVEN')throw e;required=true;}
 if(!required)throw failure('FIELD_ACTIVATION_TLS_CLIENT_CERTIFICATE_NOT_REQUIRED');
 return {...accepted,peerRequiresClientCertificate:true};
}
