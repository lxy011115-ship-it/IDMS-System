import net from 'node:net';
import type pg from 'pg';
/** PostgreSQL CancelRequest for this exact borrowed session. The backend key is
 * ephemeral and never logged, persisted, or accepted from HTTP input. This is
 * a short protocol control socket, not another database login/pool acquisition. */
export function cancelSpareQuery(client:pg.PoolClient):Promise<boolean>{
 const c=client as any,pid=c.processID,key=c.secretKey,host=c.host,port=Number(c.port);
 if(!Number.isInteger(pid)||pid<1||pid>2147483647||!Number.isInteger(key)||key< -2147483648||key>2147483647||typeof host!=='string'||!Number.isInteger(port)||port<1||port>65535)return Promise.resolve(false);
 return new Promise(resolve=>{
  const socket=host.startsWith('/')?net.connect(host+'/.s.PGSQL.'+port):net.connect({host,port});let settled=false;
  const done=(sent:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();resolve(sent);};
  const timer=setTimeout(()=>done(false),1000);timer.unref?.();socket.once('error',()=>done(false));socket.once('end',()=>done(true));
  socket.once('connect',()=>{const packet=Buffer.alloc(16);packet.writeInt32BE(16,0);packet.writeInt32BE(80877102,4);packet.writeInt32BE(pid,8);packet.writeInt32BE(key,12);socket.write(packet);});
 });
}
