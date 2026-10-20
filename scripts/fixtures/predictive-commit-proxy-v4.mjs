import net from 'node:net';
/** QA only: drop only the successful write COMMIT after a named maintenance operation. */
export async function createPredictiveCommitProxyV4(host,port,target){
 if(target!=='state_map_v1.apply_delta_v1')throw Error('PREDICTIVE_PROXY_TARGET');
 const sockets=new Set();let observedCommit=false,observedTarget=false,connections=0;
 const server=net.createServer(down=>{
  connections++;const up=net.connect({host,port});sockets.add(down);sockets.add(up);let front=Buffer.alloc(0),back=Buffer.alloc(0),startup=true,suppress=false,armed=false;
  const finish=()=>{down.destroy();up.destroy();};for(const s of [down,up]){s.on('error',finish);s.on('close',()=>{sockets.delete(s);finish();});}
  down.on('data',chunk=>{front=Buffer.concat([front,chunk]);for(;;){if(startup){if(front.length<4)break;const size=front.readInt32BE(0);if(size<8||size>1048576){finish();return;}if(front.length<size)break;front=front.subarray(size);startup=false;}
   else{if(front.length<5)break;const size=front.readInt32BE(1)+1;if(size<5||size>16777216){finish();return;}if(front.length<size)break;const packet=front.subarray(0,size);front=front.subarray(size);if(packet[0]===80&&packet.subarray(5).includes(Buffer.from('SELECT '+target+'('))){armed=true;observedTarget=true;}if(armed&&!observedCommit&&packet[0]===81&&packet.subarray(5).toString('utf8')==='COMMIT\0')suppress=true;}}
   up.write(chunk);
  });
  up.on('data',chunk=>{if(!suppress){down.write(chunk);return;}back=Buffer.concat([back,chunk]);for(;;){if(back.length<5)break;const size=back.readInt32BE(1)+1;if(size<5||size>16777216){finish();return;}if(back.length<size)break;const packet=back.subarray(0,size);back=back.subarray(size);if(packet[0]===67&&packet.subarray(5).toString('utf8')==='COMMIT\0'){observedCommit=true;finish();return;}}});
 });
 await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
 return {port:server.address().port,get observedCommit(){return observedCommit;},get observedTarget(){return observedTarget;},get connections(){return connections;},async close(){for(const s of sockets)s.destroy();await new Promise(ok=>server.close(ok));}};
}
