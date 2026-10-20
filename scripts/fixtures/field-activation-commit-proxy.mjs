import assert from 'node:assert/strict';
import net from 'node:net';

// Owned plaintext loopback PostgreSQL fixture only. We parse frame boundaries,
// retain no credentials/SQL, and discard an actual COMMIT CommandComplete.
export async function activationCommitDropProxy({host,port,database,applicationName}){
 assert.equal(host,'127.0.0.1');assert.match(database,/^idms_fieldarchivetarget_[a-f0-9]{10}$/);assert.match(applicationName,/^idms-review-root-[a-f0-9-]{36}$/);
 const sockets=new Set(),closed=[],server=net.createServer();let dropped=false,startupMatched=false,armed=false;
 const track=s=>{sockets.add(s);closed.push(new Promise(ok=>s.once('close',()=>{sockets.delete(s);ok();})));s.on('error',()=>{});return s;};
 server.on('connection',client=>{
  track(client);let upstream,start=Buffer.alloc(0),input=Buffer.alloc(0),output=Buffer.alloc(0),started=false;
  const inspect=bytes=>{input=Buffer.concat([input,bytes]);if(input.length>8*1024**2)throw Error();while(input.length>=5){const size=input.readUInt32BE(1)+1;if(size<5||size>8*1024**2)throw Error();if(input.length<size)return;const message=input.subarray(0,size);input=input.subarray(size);if(message[0]===81&&message.subarray(5).toString('utf8')==='/* IDMS_FIELD_ACTIVATION_COMMIT */ COMMIT\0')armed=true;}};
  client.on('data',bytes=>{try{
   if(started){inspect(bytes);upstream.write(bytes);return;}
   start=Buffer.concat([start,bytes]);if(start.length>8192||start.length<4)return;if(start.readUInt32BE(0)<9||start.readUInt32BE(0)>8192)throw Error();const size=start.readUInt32BE(0);if(start.length<size)return;if(start.readUInt32BE(4)!==196608)throw Error();
   const parts=start.subarray(8,size-1).toString('utf8').split('\0'),fields={};for(let i=0;i<parts.length-1;i+=2){if(Object.hasOwn(fields,parts[i]))throw Error();fields[parts[i]]=parts[i+1];}
   if(fields.user!=='idms_bootstrap'||fields.database!==database||fields.application_name!==applicationName)throw Error();startupMatched=true;started=true;
   const first=start;start=null;upstream=track(net.createConnection({host,port}));upstream.once('connect',()=>{upstream.write(first,()=>first.fill(0));});
   upstream.on('data',data=>{output=Buffer.concat([output,data]);if(output.length>8*1024**2){client.destroy();upstream.destroy();return;}while(output.length>=5){const length=output.readUInt32BE(1)+1;if(length<5||length>8*1024**2){client.destroy();upstream.destroy();return;}if(output.length<length)return;const message=output.subarray(0,length);output=output.subarray(length);if(armed&&message[0]===67&&message.subarray(5).toString('utf8')==='COMMIT\0'){dropped=true;client.destroy();upstream.destroy();return;}client.write(message);}});
   upstream.on('end',()=>client.end());upstream.on('error',()=>client.destroy());
  }catch{client.destroy();upstream?.destroy();}});
  client.on('close',()=>{upstream?.destroy();start?.fill(0);input.fill(0);output.fill(0);});
 });
 await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
 return {port:server.address().port,get dropped(){return dropped;},get startupMatched(){return startupMatched;},get activationCommitQueryObserved(){return armed;},async close(){for(const s of sockets)s.destroy();await new Promise(ok=>server.close(ok));await Promise.all(closed);}};
}
