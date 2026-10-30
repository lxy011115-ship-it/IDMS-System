import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import pg from 'pg';
const config=JSON.parse(await readFile(process.argv[2],'utf8')),clients=[];
for(const account of Object.values(config.tenants)){const c=new pg.Client({host:config.host,port:config.port,...account,application_name:'idms-owned-process-qa'});await c.connect();clients.push(c);}
const server=createServer((_q,r)=>r.end('owned-qa'));await new Promise(ok=>server.listen(0,'127.0.0.1',ok));process.send({type:'READY',port:server.address().port});
process.on('disconnect',()=>{void(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));for(const c of clients)await c.end();})();});
