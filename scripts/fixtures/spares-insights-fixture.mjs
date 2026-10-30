import pg from 'pg';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {sparesSchema,sparesHistorySchema,commandSparesCurrent} from '../../server/spares-db.ts';
import {sparesCapacitySchema} from '../../server/spares-capacity-schema.ts';
import {spareCommand} from '../../server/spares.ts';
import {spareEventHash} from '../../server/spares-audit-chain.ts';
import {canonical} from '../../server/imports.ts';
import {readSparesQuery} from '../../server/spares-query-db.ts';
import {installSpareQueryFixture} from './spares-query-fixture.mjs';
import {trackSpareClient} from './track-spares-client.mjs';
import {seedInsightsGrowth} from './spares-insights-growth-fixture.mjs';

const quote=s=>{if(!/^[a-z_][a-z0-9_]{0,62}$/.test(s))throw Error('Invalid owned role');return '"'+s+'"';};
export async function withSparesInsightsFixture(runChecks,{growth=false}={}){
 const root=resolve(import.meta.dirname,'../..'),run=randomBytes(6).toString('hex'),out=join(root,'work/spares-insights-20261030',run);await mkdir(out,{recursive:true});
 const config=JSON.parse(await readFile(join(root,'.local/postgres-runtime.json'),'utf8')),boot={host:config.host,port:config.port,user:'idms_bootstrap',password:config.bootstrapPassword};
 const database='idms_insights_qa_'+run,ownerRole=database+'_owner',appRole=database+'_app',backupRole=database+'_backup',migrationRole=database+'_migrator',marker='IDMS insights owned '+run;
 const admin=new pg.Client({...boot,database:'postgres'});await admin.connect();let created=false,pool,owner,migrator;const createdRoles=[];
 const ctx={tenantId:'qa',actorId:'manager',actorType:'USER',authMode:'oidc',roles:['spare-parts-clerk'],correlationId:'owned-insights-'+run},reviewer={...ctx,actorId:'reviewer',roles:['final-approver']};
 const refs={devices:[{code:'QA-PUMP',siteCode:'F1',name:'合成泵'}],orders:[{id:'QA-ORDER',deviceCode:'QA-PUMP',assignee:'clerk',state:'IN_PROGRESS'}]};
 const metrics={requests:0,connections:0,maxRows:0,queries:0,maxResponseBytes:0};let growthSeed=null;
 try{
  const password=randomBytes(32).toString('base64url'),migrationPassword=randomBytes(32).toString('base64url');
  for(const [name,login,pw] of [[ownerRole,false],[appRole,true,password],[backupRole,false],[migrationRole,true,migrationPassword]]){await admin.query('CREATE ROLE '+quote(name)+(login?" LOGIN PASSWORD '"+pw+"'":' NOLOGIN')+' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT');createdRoles.push(name);}
  await admin.query('GRANT '+quote(ownerRole)+' TO '+quote(migrationRole));
  await admin.query('CREATE DATABASE '+quote(database)+' OWNER '+quote(ownerRole));created=true;await admin.query('COMMENT ON DATABASE '+quote(database)+" IS '"+marker+"'");
  owner=new pg.Client({...boot,database});await owner.connect();await owner.query('SET ROLE '+quote(ownerRole));
  await owner.query(sparesSchema);await owner.query(sparesHistorySchema);await owner.query(sparesCapacitySchema);await owner.query("INSERT INTO idms_spares.state VALUES('qa',0)");await installSpareQueryFixture(owner,'qa',appRole);
  await owner.query('REVOKE ALL ON SCHEMA idms_spares FROM PUBLIC');await owner.query('GRANT USAGE ON SCHEMA idms_spares TO '+quote(appRole)+','+quote(backupRole));
  await owner.query('GRANT SELECT ON idms_spares.migrations TO '+quote(appRole));await owner.query('GRANT SELECT,UPDATE ON idms_spares.state TO '+quote(appRole));await owner.query('GRANT SELECT,INSERT,UPDATE ON idms_spares.entities TO '+quote(appRole));await owner.query('GRANT SELECT,INSERT ON idms_spares.events,idms_spares.receipts TO '+quote(appRole));await owner.query('GRANT SELECT ON ALL TABLES IN SCHEMA idms_spares TO '+quote(backupRole));
  if(growth)growthSeed=await seedInsightsGrowth(owner,ctx,refs);
  pool=new pg.Pool({host:config.host,port:config.port,user:appRole,password,database,max:2,connectionTimeoutMillis:3000});
  const tracked={async connect(){metrics.connections++;return trackSpareClient(await pool.connect(),(sql,promise)=>{if(sql instanceof pg.Query)return;metrics.queries++;void promise.then(result=>{for(const r of Array.isArray(result)?result:[result])metrics.maxRows=Math.max(metrics.maxRows,r.rows.length);},()=>{});});}};
  migrator=new pg.Client({host:config.host,port:config.port,user:migrationRole,password:migrationPassword,database});await migrator.connect();
  const proof=async c=>{const r=(await c.query("SELECT revision::text FROM public.business_state WHERE tenant_id='qa'")).rows;if(r.length!==1)throw Error('Synthetic public proof missing');return {syntheticPublicRevision:r[0].revision};};let key=0;
  const command=(action,input,actor=ctx,id='insights-'+run+'-'+(++key))=>{metrics.requests++;return commandSparesCurrent(tracked,actor,action,input,id,proof);};
  const query=async(endpoint,params={},actor=ctx)=>{metrics.requests++;const result=await readSparesQuery(tracked,actor,endpoint,new URLSearchParams(params),proof);metrics.maxResponseBytes=Math.max(metrics.maxResponseBytes,Buffer.byteLength(JSON.stringify(result)));return result;};
  // Historical evidence is generated through the real domain with a synchronous
  // fixture-only clock, then appended atomically by the QA owner. It is not an
  // application-role write or an actual-company history.
  async function historical(action,input,date,actor=ctx){
   await owner.query('BEGIN');try{
    await owner.query("SELECT revision FROM public.business_state WHERE tenant_id='qa' FOR SHARE");const head=(await owner.query("SELECT revision::text FROM idms_spares.state WHERE tenant_id='qa' FOR UPDATE")).rows[0];
    const entities=(await owner.query("SELECT body FROM idms_spares.entities WHERE tenant_id='qa'")).rows.map(r=>r.body),before=new Map(entities.map(e=>[e.id,structuredClone(e)]));
    const NativeDate=globalThis.Date;let result;
    try{globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[date+'T12:00:00Z']));}static now(){return NativeDate.parse(date+'T12:00:00Z');}};result=spareCommand({entities},action,input,actor,refs);}finally{globalThis.Date=NativeDate;}
    const changed=entities.filter(e=>canonical(e)!==canonical(before.get(e.id))),previous=(await owner.query("SELECT hash FROM idms_spares.events WHERE tenant_id='qa' ORDER BY sequence DESC LIMIT 1")).rows[0]?.hash||'GENESIS';
    for(const e of changed)await owner.query('INSERT INTO idms_spares.entities VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,kind,id) DO UPDATE SET body=EXCLUDED.body',[e.tenantId,e.id,e.kind,e.siteCode,JSON.stringify(e)]);
    const body={wireVersion:2,tenantId:'qa',actor:actor.actorId,action,at:date+'T12:00:00Z',correlationId:'domain-generated-owned-historical-evidence',previousHash:previous,before:changed.map(e=>before.get(e.id)||null),after:changed};
    await owner.query("INSERT INTO idms_spares.events VALUES('qa',$1,$2,$3::jsonb,$4)",[(BigInt(head.revision)+1n).toString(),result.siteCode,JSON.stringify(body),spareEventHash(body)]);await owner.query("UPDATE idms_spares.state SET revision=revision+1 WHERE tenant_id='qa'");await owner.query('COMMIT');return result;
   }catch(error){await owner.query('ROLLBACK');throw error;}
  }
  const result=await runChecks({run,out,database,owner,migrator,pool,tracked,ctx,reviewer,refs,proof,command,query,historical,metrics,roles:{ownerRole,appRole,backupRole}});
  await writeFile(join(out,'verification.json'),JSON.stringify({run,...result,metrics,growthSeed,syntheticPublicProjection:true,fullPlatformUat:false,customerBusinessWrites:0},null,2)+'\n');
  console.log(JSON.stringify({run,checks:result.checks.length,metrics,customerBusinessWrites:0}));
 }catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({run,error:{name:error.name,code:error.code,message:error.message}},null,2));throw error;}
 finally{
  await pool?.end();await migrator?.end();await owner?.end();const cleanup={run,dbRemoved:false,rolesRemoved:[],forcedConnections:0};
  try{if(created){const found=(await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",[database])).rows[0];if(found?.marker!==marker)throw Error('Owned database marker changed');const until=Date.now()+5000;let active;do{active=(await admin.query('SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].n;if(active===0)break;await new Promise(ok=>setTimeout(ok,100));}while(Date.now()<until);if(active!==0)throw Error('Owned QA connections remain; retained');await admin.query('DROP DATABASE '+quote(database));cleanup.dbRemoved=true;}
   for(const name of [...createdRoles].reverse()){await admin.query('DROP ROLE '+quote(name));cleanup.rolesRemoved.push(name);}await writeFile(join(out,'cleanup.json'),JSON.stringify(cleanup,null,2)+'\n');
  }finally{await admin.end();}
 }
}
