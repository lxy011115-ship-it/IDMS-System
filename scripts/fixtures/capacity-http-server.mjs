import {createServer,IncomingMessage} from 'node:http';
import pg from 'pg';
import {resident,workScheduler,sqlScheduler} from '../../server/capacity.ts';
import {stopHttpAdmission,httpCapacitySnapshot} from '../../server/request-capacity.ts';
import {workspaceCacheSnapshot} from '../../server/import-api.ts';
if(!process.send||!/^capacityqa-[a-f0-9]{10}-[0-9]+$/.test(process.env.IDMS_DEMO_NAMESPACE||'')||process.env.NODE_ENV!=='test')throw Error('Owned capacity QA IPC required');
let bodyBytes=0,entityReads=0;const emit=IncomingMessage.prototype.emit;IncomingMessage.prototype.emit=function(type,...args){if(type==='data'&&this.url)bodyBytes+=Buffer.byteLength(args[0]);return emit.call(this,type,...args);};const query=pg.Client.prototype.query;pg.Client.prototype.query=function(config,...args){if(config?.text?.includes('IDMS_ENTITY_ROWS')||config?.text?.includes('IDMS_READ_WORKSPACE_ROWS')||config?.text?.includes('IDMS_COLD_IMPORT_STATE')||typeof config==='string'&&config.includes('IDMS_COLD_IMPORT_STATE'))entityReads++;return query.call(this,config,...args);};
const {handler,closeRuntime}=await import('../../server/index.ts');
const server=createServer({headersTimeout:15000,requestTimeout:20000,maxHeaderSize:16384},handler);server.maxConnections=128;
await new Promise((ok,reject)=>{server.once('error',reject);server.listen(Number(process.env.PORT),'127.0.0.1',ok);});
const snapshot=()=>({http:httpCapacitySnapshot(),work:workScheduler.snapshot(),sql:sqlScheduler.snapshot(),memory:resident.snapshot(),cache:workspaceCacheSnapshot(),bodyBytes,entityReads});
process.on('message',m=>{
 if(m.type==='STATS')process.send({type:'DONE',id:m.id,value:snapshot()});
 if(m.type==='DRAIN'){stopHttpAdmission();void Promise.all([workScheduler.close(),sqlScheduler.close()]).then(()=>process.send({type:'DONE',id:m.id,value:snapshot()}));}
 if(m.type==='CLOSE'){stopHttpAdmission();server.close(async()=>{await closeRuntime();process.send({type:'DONE',id:m.id,value:snapshot()},()=>process.disconnect());});}
});
process.send({type:'READY'});
