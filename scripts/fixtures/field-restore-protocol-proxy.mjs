import assert from 'node:assert/strict';
import net from 'node:net';
// Private owned-QA transport only. Packet bodies and authentication data are
// never logged, returned as proof, or written to disk.
export async function ownedRestoreProtocolProxy({host,port,database,user,applicationName,mode,onHeld}){
 assert.ok(['127.0.0.1','localhost','::1'].includes(host));assert.ok(Number.isInteger(port)&&port>0&&port<65536);
 assert.match(database,/^idms_fieldarchivetarget_[a-f0-9]{10}$/);
 assert.ok(['COPY_HOLD_CONTROLLER_KILL','COPY_HOLD_ORPHAN_CONTROLLER_KILL','COMMIT_DROP_DATA','COMMIT_DROP_VERIFIED'].includes(mode));
 assert.equal(user,mode==='COMMIT_DROP_VERIFIED'?'idms_bootstrap':database+'_migrator');
 assert.match(applicationName,mode==='COMMIT_DROP_VERIFIED'?/^idms-restore-control-[a-f0-9-]{36}$/:/^idms-field-restore-[a-f0-9-]{36}$/);
 const server=net.createServer(),sockets=new Set(),ends=[];let accepted=false,startupMatched=false,copyActive=false,copyBytes=0,completedCopyRows=0,held=false,dropped=false,taggedCommit=false,problem;
 const track=s=>{sockets.add(s);ends.push(new Promise(ok=>s.once('close',()=>{sockets.delete(s);ok();})));s.on('error',()=>{});return s;};
 server.on('connection',client=>{
  track(client);if(accepted){client.destroy();return;}accepted=true;
  let upstream,first=Buffer.alloc(0),front=Buffer.alloc(0),back=Buffer.alloc(0),started=false;
  const stop=()=>{client.destroy();upstream?.destroy();};
  const bad=()=>{problem=Error('Owned protocol framing or binding failed');stop();};
  const frontend=data=>{
   front=Buffer.concat([front,data]);if(front.length>2*1024**2){bad();return;}
   while(front.length>=5&&!held){const size=front.readUInt32BE(1)+1;if(size<5||size>2*1024**2){bad();return;}if(front.length<size)return;const message=front.subarray(0,size);front=front.subarray(size);
    if(message[0]===81){const sql=message.subarray(5).toString('utf8');if(mode==='COMMIT_DROP_VERIFIED'&&sql.includes('IDMS_FIELD_TARGET_RESTORE_VERIFIED_COMMIT')||mode==='COMMIT_DROP_DATA'&&/^COMMIT\s*;?\s*\0$/.test(sql))taggedCommit=true;}
    if(copyActive&&message[0]===100)copyBytes+=message.length-5;
    if(copyActive&&message[0]===99){copyActive=false;copyBytes=0;}
    upstream.write(message);
   }
  };
  client.on('data',data=>{
   if(started){frontend(data);return;}
   first=Buffer.concat([first,data]);if(first.length>8192){bad();return;}
   while(first.length>=4){const size=first.readUInt32BE(0);if(size<8||size>8192){bad();return;}if(first.length<size)return;
    const code=first.readUInt32BE(4);if(size===8&&[80877103,80877104].includes(code)){client.write('N');first=first.subarray(size);continue;}
    if(code!==196608||first[size-1]!==0){bad();return;}
    const parts=first.subarray(8,size-1).toString('utf8').split('\0'),fields={};for(let i=0;i<parts.length-1;i+=2){if(Object.hasOwn(fields,parts[i])){bad();return;}fields[parts[i]]=parts[i+1];}
    if(fields.user!==user||fields.database!==database||fields.application_name!==applicationName){bad();return;}
    startupMatched=true;started=true;const startup=Buffer.from(first.subarray(0,size)),extra=Buffer.from(first.subarray(size));first=Buffer.alloc(0);upstream=track(net.createConnection({host,port}));upstream.once('connect',()=>{upstream.write(startup);if(extra.length)frontend(extra);});
    upstream.on('data',bytes=>{back=Buffer.concat([back,bytes]);if(back.length>2*1024**2){bad();return;}while(back.length>=5){const n=back.readUInt32BE(1)+1;if(n<5||n>2*1024**2){bad();return;}if(back.length<n)return;const message=back.subarray(0,n);back=back.subarray(n);
     if(message[0]===67){const count=/^COPY ([0-9]+)\0$/.exec(message.subarray(5).toString('utf8'));if(count){completedCopyRows+=Number(count[1]);if(!Number.isSafeInteger(completedCopyRows)){bad();return;}}}
     if(message[0]===71){copyActive=true;copyBytes=0;if(mode.startsWith('COPY_HOLD')&&completedCopyRows>0){held=true;Promise.resolve().then(onHeld).catch(e=>{problem=e;stop();});return;}}
     if(taggedCommit&&message[0]===67&&message.subarray(5).toString('utf8')==='COMMIT\0'){dropped=true;stop();return;}
     client.write(message);
    }});upstream.on('end',()=>client.end());upstream.on('close',()=>client.destroy());upstream.on('error',()=>client.destroy());return;
   }
  });client.on('close',()=>upstream?.destroy());
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 return {port:server.address().port,get startupMatched(){return startupMatched;},get held(){return held;},get completedCopyRows(){return completedCopyRows;},get dropped(){return dropped;},get socketCount(){return sockets.size;},get problem(){return problem;},async dispose(){for(const s of sockets)s.destroy();await new Promise(ok=>server.close(ok));await Promise.all(ends);}};
}
