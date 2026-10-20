import {Duplex} from 'node:stream';
import {createConnection} from 'node:net';
import {createHash} from 'node:crypto';
const error=()=>Object.assign(Error('FIELD_ACTIVATION_TLS_HELLO_UNSUPPORTED'),{code:'FIELD_ACTIVATION_TLS_HELLO_UNSUPPORTED'});
function extensions(body,offset){if(offset+2>body.length)throw error();const size=body.readUInt16BE(offset);offset+=2;if(offset+size!==body.length)throw error();const seen=new Set(),values=[];while(offset<body.length){if(offset+4>body.length)throw error();const type=body.readUInt16BE(offset),length=body.readUInt16BE(offset+2);offset+=4;if(offset+length>body.length||seen.has(type))throw error();seen.add(type);values.push({type,data:body.subarray(offset,offset+length)});offset+=length;}return values;}
export function validateActivationClientHello(body){
 if(!Buffer.isBuffer(body)||body.length<38||body.length>65536||body.readUInt16BE(0)!==0x0303)throw error();let p=34;const session=body[p++];if(session>32||p+session+2>body.length)throw error();p+=session;const ciphers=body.readUInt16BE(p);p+=2;if(ciphers<2||ciphers%2||p+ciphers+1>body.length)throw error();p+=ciphers;const compression=body[p++];if(compression<1||p+compression>body.length)throw error();p+=compression;const types=extensions(body,p).map(e=>e.type);
 // RFC 9149 permits early tickets only when requested. Block that extension,
 // PSK resumption and early data before forwarding any ClientHello bytes.
 if(types.some(t=>[41,42,58].includes(t)))throw error();return {extensionTypes:types,pskOffered:false,earlyDataOffered:false,earlyTicketRequestOffered:false};
}
function serverVersion(body){if(body.length<38||body.readUInt16BE(0)!==0x0303)throw error();const session=body[34],p=35+session+3;if(session>32||p>body.length)throw error();if(p===body.length)return 'TLSv1.2';const e=extensions(body,p).find(e=>e.type===43);if(!e)return 'TLSv1.2';if(e.data.length!==2||e.data.readUInt16BE(0)!==0x0304)throw error();return 'TLSv1.3';}

// tls.connect accepts a documented generic Duplex transport. This adapter
// validates the actual wire ClientHello instead of assuming a Node/OpenSSL
// version never requests early session tickets.
export class ActivationTlsStream extends Duplex {
 #socket;#out=Buffer.alloc(0);#handshake=Buffer.alloc(0);#pending=[];#pendingBytes=0;#in=Buffer.alloc(0);#serverHandshake=Buffer.alloc(0);#version=null;#encrypted=false;#hellos=0;#ended;#clientCertificate=null;#emptyCertificate=false;
 constructor(host,port){super({highWaterMark:65536});this.#socket=createConnection({host,port});this.#ended=new Promise(ok=>this.#socket.once('close',ok));this.on('error',()=>{});
  this.#socket.on('data',b=>{try{this.#inspectServer(b);if(!this.push(b))this.#socket.pause();}catch(e){this.destroy(e);}});this.#socket.on('end',()=>this.push(null));this.#socket.on('error',e=>this.destroy(e));this.#socket.once('close',()=>{if(!this.destroyed)this.destroy();});
 }
 get state(){return {clientHellosVerified:this.#hellos,selectedProtocol:this.#version,earlyTicketRequestForwarded:false,tls12ClientCertificateSha256:this.#clientCertificate,tls12EmptyClientCertificate:this.#emptyCertificate};}
 #certificate(body){if(this.#version!=='TLSv1.2'||body.length<3||body.readUIntBE(0,3)!==body.length-3)throw error();if(body.length===3){this.#emptyCertificate=true;return;}if(body.length<6)throw error();const size=body.readUIntBE(3,3);if(size<100||size>65536||size+6>body.length)throw error();this.#clientCertificate=createHash('sha256').update(body.subarray(6,6+size)).digest('hex');}
 async terminal(){await this.#ended;}
 #inspectServer(bytes){
  if(this.#version)return;this.#in=Buffer.concat([this.#in,bytes]);if(this.#in.length>262144)throw error();
  while(this.#in.length>=5){const length=this.#in.readUInt16BE(3);if(length>18432)throw error();if(this.#in.length<length+5)return;const record=this.#in.subarray(0,length+5);this.#in=this.#in.subarray(length+5);if(record[0]!==22)continue;this.#serverHandshake=Buffer.concat([this.#serverHandshake,record.subarray(5)]);if(this.#serverHandshake.length<4)return;const size=this.#serverHandshake.readUIntBE(1,3);if(size>65536||this.#serverHandshake[0]!==2)throw error();if(this.#serverHandshake.length<size+4)return;this.#version=serverVersion(this.#serverHandshake.subarray(4,size+4));this.#in=Buffer.alloc(0);this.#serverHandshake=Buffer.alloc(0);return;}
 }
 _read(){this.#socket.resume();}
 #send(record){if(this.#socket.writableLength+record.length>1048576)throw error();this.#socket.write(record);}
 _write(bytes,_encoding,callback){
  try{this.#out=Buffer.concat([this.#out,bytes]);if(this.#out.length>262144)throw error();while(this.#out.length>=5){const length=this.#out.readUInt16BE(3);if(length>18432)throw error();if(this.#out.length<length+5)break;const record=Buffer.from(this.#out.subarray(0,length+5));this.#out=this.#out.subarray(length+5);
   if(record[0]===20&&this.#version==='TLSv1.2')this.#encrypted=true;if(record[0]===23)this.#encrypted=true;
   if(record[0]===22&&!this.#encrypted){this.#pending.push(record);this.#pendingBytes+=record.length;if(this.#pendingBytes>262144)throw error();this.#handshake=Buffer.concat([this.#handshake,record.subarray(5)]);while(this.#handshake.length>=4){const size=this.#handshake.readUIntBE(1,3),type=this.#handshake[0];if(size>262144||type===1&&size>65536)throw error();if(this.#handshake.length<size+4)break;if(type===1){validateActivationClientHello(this.#handshake.subarray(4,size+4));this.#hellos++;}else if(!this.#hellos)throw error();else if(type===11)this.#certificate(this.#handshake.subarray(4,size+4));this.#handshake=this.#handshake.subarray(size+4);}if(!this.#handshake.length){for(const p of this.#pending)this.#send(p);this.#pending=[];this.#pendingBytes=0;}}
   else{if(!this.#hellos||this.#handshake.length)throw error();this.#send(record);}
  }callback();}catch(e){callback(e);}
 }
 _final(callback){this.#socket.end(callback);}
 _destroy(reason,callback){this.#socket.destroy();void this.#ended.then(()=>{this.#out.fill(0);this.#handshake.fill(0);for(const p of this.#pending)p.fill(0);this.#out=Buffer.alloc(0);this.#pending=[];callback(reason);});}
}
