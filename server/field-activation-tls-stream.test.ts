import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:net';
import {ActivationTlsStream,validateActivationClientHello} from '../scripts/field-activation-tls-stream.mjs';
function hello(types:number[]=[]){const extensions=Buffer.concat(types.map(t=>{const b=Buffer.alloc(4);b.writeUInt16BE(t,0);return b;})),prefix=Buffer.concat([Buffer.from([3,3]),Buffer.alloc(32),Buffer.from([0,0,2,0x13,1,1,0])]),length=Buffer.alloc(2);length.writeUInt16BE(extensions.length);return Buffer.concat([prefix,length,extensions]);}
function record(body:Buffer){const handshake=Buffer.alloc(4);handshake[0]=1;handshake.writeUIntBE(body.length,1,3);return Buffer.concat([handshake,body]);}
const tlsRecord=(b:Buffer)=>{const h=Buffer.from([22,3,3,0,0]);h.writeUInt16BE(b.length,3);return Buffer.concat([h,b]);};
test('actual ClientHello parser rejects PSK, early data, early ticket requests and ambiguous extensions',()=>{
 assert.equal(validateActivationClientHello(hello([10,43])).earlyTicketRequestOffered,false);
 for(const types of [[58],[41],[42],[43,43]])assert.throws(()=>validateActivationClientHello(hello(types)),(e:any)=>e.code==='FIELD_ACTIVATION_TLS_HELLO_UNSUPPORTED');
 const truncated=hello([10]);truncated[truncated.length-1]=1;assert.throws(()=>validateActivationClientHello(truncated));
});
test('prohibited ClientHello bytes never reach the actual TCP peer',async()=>{
 let bytes=0;const sockets=new Set<any>(),server=createServer(s=>{sockets.add(s);s.on('data',b=>bytes+=b.length);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));});await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));const stream=new ActivationTlsStream('127.0.0.1',(server.address() as any).port);
 try{await assert.rejects(new Promise<void>((ok,no)=>stream.write(tlsRecord(record(hello([58]))),(e:any)=>e?no(e):ok())),(e:any)=>e.code==='FIELD_ACTIVATION_TLS_HELLO_UNSUPPORTED');stream.destroy();await stream.terminal();assert.equal(bytes,0);}finally{stream.destroy();await stream.terminal();for(const s of sockets)s.destroy();await new Promise<void>(ok=>server.close(()=>ok()));}
});
test('fragmented ClientHello records are held until validation, then forwarded exactly',async()=>{
 const received:Buffer[]=[],sockets=new Set<any>(),server=createServer(s=>{sockets.add(s);s.on('data',b=>received.push(b));s.on('error',()=>{});s.once('close',()=>sockets.delete(s));});await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));const stream=new ActivationTlsStream('127.0.0.1',(server.address() as any).port),body=record(hello([10,43])),first=tlsRecord(body.subarray(0,9)),last=tlsRecord(body.subarray(9));
 try{await new Promise<void>((ok,no)=>stream.write(first,(e:any)=>e?no(e):ok()));await new Promise(ok=>setTimeout(ok,15));assert.equal(received.length,0);await new Promise<void>((ok,no)=>stream.write(last,(e:any)=>e?no(e):ok()));const deadline=Date.now()+2000;while(Buffer.concat(received).length<first.length+last.length){assert.ok(Date.now()<deadline);await new Promise(ok=>setTimeout(ok,5));}assert.deepEqual(Buffer.concat(received),Buffer.concat([first,last]));assert.equal(stream.state.clientHellosVerified,1);}finally{stream.destroy();await stream.terminal();for(const s of sockets)s.destroy();await new Promise<void>(ok=>server.close(()=>ok()));}
});
