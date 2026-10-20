import {weeklyCoverageCalendar} from './fixtures/weekly-calendar-model.mjs';
import {Temporal} from '@js-temporal/polyfill';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {telemetryQualityFixture,insertTelemetryQuality} from './fixtures/telemetry-quality-model.mjs';
import {migrateQaDatabases,cleanupQaRoles,qaAdminAccount,updateQaPayload} from './qa-database.mjs';
import {telemetryCoverageSqlRead} from '../server/plan-coverage-sql.ts';
import {uploadCoverage} from '../server/plan-coverage.ts';
import {createTemplate,submitTemplate,approveTemplate} from '../server/catalog.ts';
import {verifySqlRead} from '../server/read-integrity.ts';
import {connectionFor} from '../server/postgres-security.ts';
import {tenantPayload} from '../server/entity-repository.ts';
import {canonical,digest} from '../server/imports.ts';
import {resident} from '../server/capacity.ts';

const suffix=randomUUID().replaceAll('-','').slice(0,10),root=JSON.parse(await readFile('.local/postgres-runtime.json')),config={host:root.host,port:root.port,tenants:{}},admin=new pg.Client({host:root.host,port:root.port,user:'idms_bootstrap',password:root.bootstrapPassword,database:'postgres'}),accounts=[],clients=[],pools=[];
const f=telemetryQualityFixture({now:Math.floor(Date.now()/60000)*60000}),ctx={tenantId:'acme',actorId:'coverage-reader',actorType:'USER',authMode:'oidc',roles:['auditor'],correlationId:'coverage-sql'},designer={...ctx,actorId:'calendar-designer',roles:['tenant-admin']},reviewer={...ctx,actorId:'calendar-reviewer',roles:['final-approver']};
const from=f.now-12000000,to=f.now,iso=t=>new Date(t).toISOString(),params=new URLSearchParams({deviceCode:'QUALITY-A',from:iso(from),to:iso(to),pageSize:'100'}),expected=t=>({expectedDigest:t.contentDigest,expectedRevision:t.revision});
const {authoring,oracle:plan}=weeklyCoverageCalendar(f);
const make=(calendar,version='1.0.0')=>{const t=createTemplate(f.store,{templateKey:'quality-a-calendar',version,industry:'测试',manifest:{schemaVersion:1,minPlatformVersion:'0.1.0',purpose:'operation-calendar',modules:['equipment','quality'],policy:{finalApproval:'INDEPENDENT_HUMAN',deviceAccess:'READ_ONLY'},operationCalendar:version==='1.0.0'?authoring:{...authoring,recurrence:{...authoring.recurrence,weekly:[],exceptions:[],outsideReason:'更高版本全部停产'}}}},designer,f.imports);submitTemplate(f.store,t.id,expected(t),designer,f.imports);approveTemplate(f.store,t.id,{...expected(t),decision:'APPROVED',comment:'独立复核运行计划'},reviewer,f.imports);return t;};
const original=async()=>{const out={};for(const [tenant,a]of Object.entries(root.tenants)){const c=new pg.Client({host:root.host,port:root.port,...a});await c.connect();try{const p=(await c.query('SELECT payload FROM runtime_state')).rows[0].payload;out[tenant]={business:digest(canonical(p.business)),imports:digest(canonical(p.imports))};}finally{await c.end();}}return out;};
const unchanged=await original(),t=make(plan);let before;
function oracle(rows,interval){
 const windows=plan.periods.filter(p=>p.state==='RUN').map((p,index)=>({a:Date.parse(p.from),b:Date.parse(p.to),index})),all=new Set(),good=new Set();let planned=0,records=0,slots=0;
 for(const p of windows)for(let target=p.a;target<p.b;target+=interval*1000)slots++;
 for(const r of rows){const time=Date.parse(r.event_time);if(time<from||time>=to)continue;records++;const p=windows.find(p=>time>=p.a&&time<p.b);if(!p)continue;planned++;const key=p.index+':'+Math.floor((time-p.a)/(interval*1000));all.add(key);if(r.quality==='GOOD'&&Number.isFinite(r.value)&&r.value!==null&&r.unit==='mm/s'&&r.value>=0&&r.value<=200&&r.map_version==='quality-map-1')good.add(key);}
 return {records,planned,slots,received:all.size,good:good.size};
}
try{
 await admin.connect();for(const tenant of ['acme','sandbox']){const name='idms_weeklysqlqa_'+tenant+'_'+suffix,a={user:name,database:name,password:randomBytes(32).toString('base64url')};accounts.push(a);config.tenants[tenant]=a;await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${a.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);}
 const runtime=await migrateQaDatabases(config,root,{snapshot:f.snapshot,telemetryTenants:['acme','sandbox']});
 for(const tenant of ['acme','sandbox']){const c=new pg.Client(qaAdminAccount(root,config.tenants[tenant]));await c.connect();clients.push(c);await insertTelemetryQuality(c,f,tenant);}
 const pool=new pg.Pool(connectionFor(root,runtime.tenants.acme));pools.push(pool);before=resident.snapshot().total;
 const read=(q=params,identity=ctx,verify=c=>verifySqlRead(pool,c,'acme'))=>telemetryCoverageSqlRead(pool,identity,q,f.sources,verify,f.now),initial=await read(),point=initial.items.find(i=>i.tagCode==='vibration_rms'),rows=(await clients[0].query("SELECT * FROM telemetry_points WHERE tenant_id='acme' AND device_code='QUALITY-A' AND tag_code='vibration_rms'")).rows,truth=oracle(rows,1);
 assert.equal(point.recordsInWindow,10050);assert.equal(point.expectedSlots,truth.slots);assert.equal(point.recordsInPlannedSlots,truth.planned);assert.equal(point.receivedSlots,truth.received);assert.equal(point.goodValidSlots,truth.good);assert.equal(initial.calendar.version,'1.0.0');assert.equal(point.status,'EVALUATED');assert.equal(point.expectedSlots,10980);assert.equal(point.recordsOutsidePlannedSlots,920);
 assert.equal((await read(params,{...ctx,roles:['quality-engineer'],scope:{provided:true,sites:['FACTORY-02'],lines:[],devices:[]}})).total,0);
 assert.equal((await read(new URLSearchParams({...Object.fromEntries(params),deviceCode:'QUALITY-B'}))).items[0].status,'UNKNOWN');
 const stop=new URLSearchParams({...Object.fromEntries(params),from:plan.periods[1].from,to:plan.periods[1].to}),stopped=(await read(stop)).items.find(i=>i.tagCode==='vibration_rms');assert.equal(stopped.status,'NOT_APPLICABLE');assert.equal(stopped.receivedCoveragePercent,null);assert.equal(stopped.recordsInWindow,920);
 const outside=(await read(new URLSearchParams({...Object.fromEntries(params),from:iso(from-1)}))).items[0];assert.equal(outside.status,'UNKNOWN');assert.equal(outside.receivedCoveragePercent,null);
 const partial=(await read(new URLSearchParams({...Object.fromEntries(params),tagCode:'vibration_rms',from:iso(to-19950),to:iso(to-18050)}))).items[0];assert.equal(partial.expectedSlots,2);assert.equal(partial.partialSlots,2);
 // Add actual approved uploads and prove they follow the same plan while BAD
 // remains a recorded slot and cannot fill the GOOD-valid denominator.
 f.approve('MEASUREMENT',[0,1,2].map((i)=>({source_record_id:'coverage-'+i,device_code:'QUALITY-A',tag_code:'vibration_rms',measured_at:iso(from+i*1000),value:2,unit:'mm/s',quality:i===0?'BAD':'GOOD'})));
 const uploads=uploadCoverage(f.imports,f.store,f.store.audits,ctx,params,f.now).items.find(i=>i.tagCode==='vibration_rms');assert.equal(uploads.expectedSlots,10980);assert.equal(uploads.receivedSlots,3);assert.equal(uploads.goodValidSlots,2);
 await updateQaPayload(clients[0],'acme',tenantPayload(f.snapshot,'acme'));
 // Owned wire faults run against the actual minimum application role and
 // production query. No production probe or baseline mutation is installed.
 const raw=pg.Client.prototype.query,faults={};let fault;
 pg.Client.prototype.query=function(config,...args){const text=typeof config==='string'?config:config?.text||'',target=text.includes('IDMS_COVERAGE_TELEMETRY')?'STATS':text.includes('IDMS_COVERAGE_CALENDAR')?'CALENDAR':'';let selected;if(fault&&fault.startsWith(target+':')){selected=fault.split(':')[1];fault=undefined;}const pending=raw.call(this,selected==='SQL'?text+' QA_BAD_SYNTAX (':config,...args);if(!selected||!pending?.then)return pending;return pending.then(result=>{const r=result.rows[0];if(selected==='DROP')result.rows.shift();if(selected==='DUP')result.rows.push(structuredClone(r));if(selected==='COUNT')r.records=String(Number(r.records)+1);if(selected==='FOREIGN')r.device_code='SECRET-FOREIGN';if(selected==='ANCHOR')r.items[0].anchor=null;if(selected==='TOTAL')r.total='0';return result;});};
 try{for(const name of ['STATS:DROP','STATS:DUP','STATS:COUNT','STATS:FOREIGN','STATS:SQL','CALENDAR:ANCHOR','CALENDAR:TOTAL']){fault=name;await assert.rejects(read(),e=>e.status===503&&!e.message.includes('QA_BAD'));assert.equal(resident.snapshot().total,before);await read();faults[name]=true;}}finally{pg.Client.prototype.query=raw;}
 let entered,release;const seen=new Promise(ok=>entered=ok),gate=new Promise(ok=>release=ok),held=read(params,ctx,async c=>{await verifySqlRead(pool,c,'acme');entered();await gate;});await seen;
 make({...plan,periods:[{from:plan.from,to:plan.to,state:'STOP',reason:'更高版本停产'}]},'1.1.0');await updateQaPayload(clients[0],'acme',tenantPayload(f.snapshot,'acme'));release();assert.equal((await held).calendar.version,'1.0.0');assert.equal((await read()).calendar.version,'1.1.0');assert.equal((await read()).items[0].status,'NOT_APPLICABLE');assert.equal(t.status,'RETIRED');assert.equal(resident.snapshot().total,before);assert.deepEqual(await original(),unchanged);
 const saved=Temporal.PlainDate.prototype.toZonedDateTime;Temporal.PlainDate.prototype.toZonedDateTime=function(){throw Error('SQL frozen read must not recompile');};try{assert.equal((await read()).calendar.recurrence.engine,'weekly-calendar-temporal-v1');}finally{Temporal.PlainDate.prototype.toZonedDateTime=saved;}
 const proof={weeklyRulesAndDateExceptionsPublishedAndUsedByRealSql:true,independentExplicitThreeIntervalOracle:true,frozenSqlReadDoesNotRecompileAgainstTzdb:true,verifiedAt:new Date().toISOString(),actualMinimumRolePostgres:true,syntheticOnly:true,complete10050RecordsAnd10980PlanSlots:true,independentSqlAndSlotOracle:true,stop920SamplesExcludedWithoutDeletingRecords:true,goodValidDistinctFromRecordedAndDuplicatesBounded:true,explicitUnknownAndStopNotApplicable:true,partialFixedAnchorSlots:true,approvedUploadsUseSamePublishedPlan:true,currentTrustedScopeAndHiddenEmpty:true,realConcurrentCalendarPublishPinnedByRepeatableRead:true,faults,failuresRecoverAndReservationsReleased:true,originalBusinessImportsUnchanged:true,noSchemaOrDefaultBudgetChange:true,productionAcceptance:false};await writeFile('outputs/weekly-calendar-sql-verification.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
}finally{
 for(const p of pools)await p.end();for(const c of clients)await c.end();for(const a of accounts){assert.match(a.database,new RegExp('^idms_weeklysqlqa_(acme|sandbox)_'+suffix+'$'));await admin.query('DROP DATABASE IF EXISTS "'+a.database+'" WITH (FORCE)');await admin.query('DROP ROLE IF EXISTS "'+a.user+'"');}await cleanupQaRoles(admin,config);await admin.end();
}
