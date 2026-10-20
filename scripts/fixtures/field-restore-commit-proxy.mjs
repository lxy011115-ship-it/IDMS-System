import assert from 'node:assert/strict';
import net from 'node:net';
// Owned local QA only: discard the server's actual COMMIT completion message.
// No packet bodies or credentials are logged or returned.
export async function restoreCommitDropProxy({host,port,user,database,applicationName}){
 assert.match(database,/^idms_fieldarchivetarget_[a-f0-9]{10}$/);assert.equal(user,database+'_migrator');
 const sockets=new Set(),closed=[],server=net.createServer();let dropped=false,startupMatched=false;
 const track=s=>{sockets.add(s);closed.push(new Promise(ok=>s.once('close',()=>{sockets.delete(s);ok();})));s.on('error',()=>{});return s;};
 server.on('connection',client=>{
  track(client);let upstream,first=Buffer.alloc(0),pending=Buffer.alloc(0),started=false;
  client.on('data',data=>{
   if(started){upstream.write(data);return;}
   first=Buffer.concat([first,data]);if(first.length>8192){client.destroy();return;}if(first.length<4)return;const length=first.readUInt32BE(0);if(length<9||length>8192){client.destroy();return;}if(first.length<length)return;
   if(first.readUInt32BE(4)!==196608){client.destroy();return;}
   const parts=first.subarray(8,length-1).toString('utf8').split('\0'),fields={};for(let i=0;i<parts.length-1;i+=2){if(Object.hasOwn(fields,parts[i])){client.destroy();return;}fields[parts[i]]=parts[i+1];}
   if(fields.user!==user||fields.database!==database||fields.application_name!==applicationName){client.destroy();return;}
   startupMatched=true;started=true;upstream=track(net.createConnection({host,port}));upstream.once('connect',()=>{upstream.write(first);first=null;});
   upstream.on('data',bytes=>{
    pending=Buffer.concat([pending,bytes]);if(pending.length>262144){client.destroy();upstream.destroy();return;}
    while(pending.length>=5){const size=pending.readUInt32BE(1)+1;if(size<5||size>262144){client.destroy();upstream.destroy();return;}if(pending.length<size)return;const message=pending.subarray(0,size);pending=pending.subarray(size);
     if(message[0]===67&&message.subarray(5).toString('utf8')==='COMMIT\0'){dropped=true;client.destroy();upstream.destroy();return;}
     client.write(message);
    }
   });
   upstream.on('end',()=>client.end());upstream.on('error',()=>client.destroy());
  });
  client.on('close',()=>upstream?.destroy());
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 return {port:server.address().port,get dropped(){return dropped;},get startupMatched(){return startupMatched;},async dispose(){for(const s of sockets)s.destroy();await new Promise(ok=>server.close(ok));await Promise.all(closed);}};
}
