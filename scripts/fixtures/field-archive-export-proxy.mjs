import assert from 'node:assert/strict';
import net from 'node:net';
// Owned QA only. Relay opaque authentication/COPY bytes without logging them.
export async function ownedArchiveExportProxy({host,port,database,user,applicationName,onHeld}){
 assert.ok(['127.0.0.1','localhost','::1'].includes(host));assert.ok(Number.isInteger(port)&&port>0&&port<65536);
 assert.match(database,/^idms_fieldarchiveqa_acme_[a-f0-9]{10}$/);assert.match(user,new RegExp('^'+database+'_[a-z0-9_]+$'));assert.match(applicationName,/^idms-field-archive-[a-f0-9-]{36}$/);
 const server=net.createServer(),sockets=new Set(),ends=[];let accepted=false,started=false,held=false,problem,completedRows=0,forwardedBytes=0,copyOut=false;
 const track=s=>{sockets.add(s);ends.push(new Promise(ok=>s.once('close',()=>{sockets.delete(s);ok();})));s.on('error',()=>{});return s;};
 server.on('connection',client=>{
  track(client);if(accepted){client.destroy();return;}accepted=true;let upstream,first=Buffer.alloc(0),pending=Buffer.alloc(0);
  const stop=()=>{client.destroy();upstream?.destroy();};
  const bad=()=>{problem=Error('Owned export protocol framing or identity failed');stop();};
  client.on('data',data=>{
   if(started){upstream.write(data);return;}
   first=Buffer.concat([first,data]);if(first.length>8192){bad();return;}
   while(first.length>=4){const n=first.readUInt32BE(0);if(n<8||n>8192){bad();return;}if(first.length<n)return;const code=first.readUInt32BE(4);
    if(n===8&&[80877103,80877104].includes(code)){client.write('N');first=first.subarray(n);continue;}
    if(code!==196608||first[n-1]!==0){bad();return;}const parts=first.subarray(8,n-1).toString('utf8').split('\0'),fields={};for(let i=0;i<parts.length-1;i+=2){if(Object.hasOwn(fields,parts[i])){bad();return;}fields[parts[i]]=parts[i+1];}
    if(fields.user!==user||fields.database!==database||fields.application_name!==applicationName||fields.options!=='-c statement_timeout=120000 -c default_transaction_read_only=on'){bad();return;}
    started=true;const startup=Buffer.from(first);first=Buffer.alloc(0);upstream=track(net.createConnection({host,port}));upstream.once('connect',()=>upstream.write(startup));
    upstream.on('data',bytes=>{pending=Buffer.concat([pending,bytes]);if(pending.length>2*1024**2){bad();return;}
     while(pending.length>=5&&!held){const size=pending.readUInt32BE(1)+1;if(size<5||size>2*1024**2){bad();return;}if(pending.length<size)return;const message=pending.subarray(0,size);pending=pending.subarray(size);
      if(message[0]===72)copyOut=true;
      if(copyOut&&completedRows>0&&[100,99].includes(message[0])){held=true;upstream.pause();Promise.resolve().then(onHeld).catch(e=>{problem=e;stop();});return;}
      if(copyOut&&message[0]===100)forwardedBytes+=message.length-5;
      if(message[0]===67){const count=/^COPY ([0-9]+)\0$/.exec(message.subarray(5).toString('utf8'));if(count){completedRows+=Number(count[1]);copyOut=false;if(!Number.isSafeInteger(completedRows)){bad();return;}}}
      client.write(message);
     }
    });upstream.on('error',()=>client.destroy());upstream.on('end',()=>client.end());upstream.on('close',()=>client.destroy());return;
   }
  });client.on('close',()=>upstream?.destroy());
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 return {port:server.address().port,get held(){return held;},get startupMatched(){return started;},get completedRows(){return completedRows;},get forwardedCopyBytes(){return forwardedBytes;},get socketCount(){return sockets.size;},get problem(){return problem;},async dispose(){for(const s of sockets)s.destroy();await new Promise(ok=>server.close(ok));await Promise.all(ends);}};
}
