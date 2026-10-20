// Conservative reference: old full workspace validation plus frozen old SQL.
// It omits the additional old applyTenant clone, so measured gains are not inflated.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {handler} from '../../server/index.ts';
import {createRuntimeAuthStore} from '../../server/auth-store.ts';
import {createAuth,authConfigFromEnv} from '../../server/auth.ts';
import {storageMode,closePostgres} from '../../server/postgres-repository.ts';
import {connectionFor,validateRuntimeConfig} from '../../server/postgres-security.ts';
import {readEntities} from './workspace-baseline-entities.ts';
import {authorize} from '../../server/imports.ts';
import {assetCsv,measurementCsv,exportFilters} from '../../server/data-export.ts';
import {dataOverviewSql,dataMeasurementsSql} from './read-capacity-baseline-sql.ts';

if(process.env.NODE_ENV!=='test'||!/^readqa-[a-f0-9]{10}-0$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Frozen baseline is restricted to the owned read-capacity QA namespace');
// Keep the original pool timeouts. A later production idle-transaction deadline
// must not terminate this historical reference while its second connection runs.
const database=validateRuntimeConfig(JSON.parse(await readFile(process.env.IDMS_POSTGRES_CONFIG,'utf8'))),pools=new Map(Object.entries(database.tenants).map(([tenant,a])=>[tenant,new pg.Pool({...connectionFor(database,a),max:4,application_name:'idms-business'})]));
for(const pool of pools.values())pool.on('error',()=>console.error('QA reference idle database connection failed'));
async function referenceRead(tenant,task){const pool=pools.get(tenant),client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT revision FROM business_state WHERE tenant_id=$1 FOR SHARE',[tenant]);await readEntities(client,tenant);const result=await task(pool);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}}
const config=authConfigFromEnv(),auth=createAuth(config,undefined,await createRuntimeAuthStore(config,storageMode));
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(req.method!=='GET'||!['/api/v1/data-management/overview','/api/v1/data-management/measurements','/api/v1/data-management/assets/export','/api/v1/data-management/measurements/export'].includes(url.pathname))return handler(req,res);
 try{
  const ctx=await auth.context(req);authorize(ctx,'read');const exporting=url.pathname.endsWith('/export'),assets=url.pathname.endsWith('/overview')||url.pathname.endsWith('/assets/export'),params=exporting?exportFilters(url.searchParams):url.searchParams;
  const result=await referenceRead(ctx.tenantId,pool=>assets?dataOverviewSql(pool,ctx,params,exporting):dataMeasurementsSql(pool,ctx,params,exporting));
  res.writeHead(200,{'content-type':exporting?'text/csv; charset=utf-8':'application/json; charset=utf-8','cache-control':'no-store'});res.end(exporting?(assets?assetCsv(result):measurementCsv(result)):JSON.stringify(result));
 }catch(e){res.writeHead(e.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));}
});
server.listen(Number(process.env.PORT),'127.0.0.1');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(async()=>{await auth.close();await Promise.all([...pools.values()].map(pool=>pool.end()));await closePostgres();process.exit(0);}));
