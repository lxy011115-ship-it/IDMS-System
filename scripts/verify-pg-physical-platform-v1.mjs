import assert from 'node:assert/strict';
import {mkdir,readFile,copyFile,open,lstat,writeFile,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {canonical} from '../server/imports.ts';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {createOwnedPlatformPgQaV1} from './fixtures/owned-platform-pg-v1-qa.mjs';
import {captureColdImageV1,restoreColdImageV1,generateColdImageKeyV1} from './pg-cold-image-portable-v1.mjs';
import {coldStoppedV1} from './pg-cold-image-portable-tools-v1.mjs';
import {runtimeWriteFenceSchemaSqlV1,runtimeWriteFenceAttachSqlV1,restrictRuntimeWriteFenceActorsV1} from './runtime-write-fence-schema-v1.mjs';
import {finalizeRuntimeWriteFenceV1} from './runtime-write-fence-control-v1.mjs';
import {inspectRuntimeWriteFenceCatalogV1} from './runtime-write-fence-catalog-v1.mjs';
import {coldRuntimeInventoryV1,coldRuntimeStructureV1} from './runtime-cold-facts-v1.mjs';
import {cleanupRuntimeColdSqlV1} from './runtime-cold-cleanup-v1.mjs';

assert.equal(process.argv.length,3,'PLATFORM_QA_BIN_ARGUMENT');
const bin=await realpath(resolve(process.argv[2])),exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const version=(await exec(join(bin,process.platform==='win32'?'postgres.exe':'postgres'),['--version'],{windowsHide:true})).stdout.trim();
if(process.env.GITHUB_ACTIONS==='true')console.log('::notice title=Actual PostgreSQL version::'+version.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));
console.log(JSON.stringify({platform:process.platform,postgresVersion:version}));
const pins=[],paths=new Set(['scripts/verify-pg-physical-platform-v1.mjs']);
async function collect(path){if(!/\.(?:mjs|ts)$/.test(path))return;const source=await readFile(path,'utf8');for(const m of source.matchAll(/(?:from\s*|import\s*\(?\s*|new URL\s*\(\s*)['"](\.[^'"\r\n]+)['"]/g)){const p=resolve(dirname(path),m[1]).slice(resolve('.').length+1).replaceAll('\\','/');if(!/\.(?:mjs|ts|sql)$/.test(p)||paths.has(p))continue;paths.add(p);await collect(p);}}
for(const p of [...paths])await collect(p);for(const p of [...paths].sort())pins.push({path:p,sha256:sha(await readFile(p))});
const report={format:'IDMS_PG_PHYSICAL_PLATFORM_QA_V1',platform:process.platform,postgresVersion:version,passed:false,checks:[],sourcePins:pins,resources:[],cleanup:{},fullRuntimeAdmissionTested:false};
let cluster,work,problem;const clients=new Set(),q=n=>'"'+n.replaceAll('"','""')+'"';
const connect=async account=>{const c=new pg.Client({...account,connectionTimeoutMillis:5000});c.on('error',()=>{});await c.connect();clients.add(c);return c;};
const end=async c=>{await c.end();clients.delete(c);};
const note=name=>{report.checks.push(name);console.log(JSON.stringify({check:report.checks.length,name,platform:process.platform}));};
async function facts(c,loid){return{data:(await c.query('SELECT id,label,meta,octet_length(payload) AS bytes,md5(payload) AS digest FROM public.platform_probe ORDER BY id')).rows,sequence:(await c.query('SELECT last_value::text,is_called FROM public.platform_probe_seq')).rows[0],largeObject:(await c.query('SELECT octet_length(lo_get($1::oid)) AS bytes,md5(lo_get($1::oid)) AS digest',[loid])).rows[0]};}
try{
 cluster=await createOwnedPlatformPgQaV1(bin);report.nonce=cluster.nonce;report.clusterWork=cluster.work;work=resolve('work/pg-physical-platform-verification-v1-20261022',cluster.nonce);await privateDirectory(work);
 const owner='platform_owner_'+cluster.nonce,app='platform_app_'+cluster.nonce,password=randomBytes(32).toString('base64url'),databases=[];const admin=await connect(cluster.account);
 for(const [name,login]of[[owner,false],[app,true]]){await admin.query('CREATE ROLE '+q(name)+' '+(login?"LOGIN PASSWORD '"+password+"'":'NOLOGIN')+' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');report.resources.push({type:'role',name,oid:(await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0].oid});}
 for(const suffix of ['a','b']){const database='platform_'+suffix+'_'+cluster.nonce;await admin.query('CREATE DATABASE '+q(database)+' OWNER '+q(owner));report.resources.push({type:'database',name:database,owner,oid:(await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1',[database])).rows[0].oid});await admin.query('REVOKE ALL ON DATABASE '+q(database)+' FROM PUBLIC');await admin.query('GRANT CONNECT ON DATABASE '+q(database)+' TO '+q(app));
  const account={...cluster.account,database},c=await connect(account),deployment=randomUUID();await c.query('BEGIN');await c.query(await runtimeWriteFenceSchemaSqlV1({owner,control:cluster.account.user,deployment}));await c.query('SET ROLE '+q(owner)+';CREATE TABLE public.platform_probe(id integer PRIMARY KEY,label text NOT NULL,meta jsonb NOT NULL,payload bytea NOT NULL);CREATE SEQUENCE public.platform_probe_seq;GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON public.platform_probe TO '+q(app)+';RESET ROLE');
  await c.query('INSERT INTO public.platform_probe VALUES(1,$1,$2,$3),(2,$4,$5,$6)',['设备-'+suffix,JSON.stringify({设备:'轴承',批次:cluster.nonce}),randomBytes(512*1024),'second-'+suffix,JSON.stringify({sample:2}),Buffer.from('数据\u0000\u00ff','utf8')]);await c.query("SELECT nextval('public.platform_probe_seq') FROM generate_series(1,7)");const loid=(await c.query('SELECT lo_from_bytea(0,$1) AS id',[randomBytes(32768)])).rows[0].id;
  await c.query(runtimeWriteFenceAttachSqlV1('public'));await restrictRuntimeWriteFenceActorsV1(c,[app]);await c.query('COMMIT');const binding=await finalizeRuntimeWriteFenceV1(account),before=await facts(c,loid),structure=await coldRuntimeStructureV1(c);await end(c);
  const actor=await connect({...account,user:app,password});assert.equal((await actor.query('SELECT count(*)::int AS n FROM public.platform_probe')).rows[0].n,2);await assert.rejects(actor.query('UPDATE public.platform_probe SET label=label WHERE false'),/RUNTIME_FENCE_CLOSED/);await end(actor);databases.push({database,loid,binding,before,structure});
 }
 note('two real PostgreSQL databases retain Unicode/JSON/binary rows, sequence values and large objects; sealed SQL catalogs deny actual APP writes while reads work');
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()")).rows[0].n,0);
 await admin.query('BEGIN;ALTER ROLE '+q(app)+' NOLOGIN CONNECTION LIMIT 0');for(const d of databases)await admin.query('ALTER DATABASE '+q(d.database)+' CONNECTION LIMIT 0');await admin.query('COMMIT');const frozen=await coldRuntimeInventoryV1(admin);report.frozenInventory={systemIdentifier:frozen.identity.system_id,databases:frozen.databases.map(d=>({oid:d.oid,name:d.datname,owner:d.datdba,connectionLimit:d.datconnlimit})),roles:frozen.roles.map(r=>({oid:r.oid,name:r.rolname,login:r.rolcanlogin,connectionLimit:r.rolconnlimit}))};await end(admin);await cluster.stop();
 note('all owned SQL clients end, APP is NOLOGIN/limit0 and database limits0, source smart stop verifies clean control block and retired original PID');
 const scratch=join(work,'scratch'),archives=join(work,'archives');await mkdir(scratch);await mkdir(archives);const keyFile=join(work,'key.private.json'),wrongKey=join(work,'wrong-key.private.json');await generateColdImageKeyV1(keyFile);await generateColdImageKeyV1(wrongKey);
 const backup=await captureColdImageV1({sourceDirectory:cluster.source,binDirectory:bin,expectedSystemIdentifier:cluster.systemIdentifier,keyFile,workDirectory:scratch,outputDirectory:archives,evidence:{purpose:'LINUX_AND_WINDOWS_PHYSICAL_PLATFORM_QA_V1',nonce:cluster.nonce,automaticAdmission:false}});report.backup={sha256:backup.sha256,bytes:backup.bytes,files:backup.files,payloadBytes:backup.payloadBytes,systemIdentifier:backup.systemIdentifier};
 note('real entire clean PostgreSQL data directory is captured in an authenticated encrypted cold image using pinned actual executable hashes');
 const restore={backupFile:backup.file,keyFile,workDirectory:scratch,targetDirectory:cluster.target,binDirectory:bin,expectedBackupId:backup.backupId,expectedSystemIdentifier:cluster.systemIdentifier};
 await assert.rejects(restoreColdImageV1({...restore,keyFile:wrongKey}),/COLD_IMAGE_(?:KEY|AUTHENTICATION)/);await assert.rejects(lstat(cluster.target),{code:'ENOENT'});
 const corrupt=join(archives,'corrupt.private.bin');await copyFile(backup.file,corrupt);const handle=await open(corrupt,'r+');try{const stat=await handle.stat(),byte=Buffer.alloc(1);await handle.read(byte,0,1,stat.size-1);byte[0]^=1;await handle.write(byte,0,1,stat.size-1);await handle.sync();}finally{await handle.close();}
 await assert.rejects(restoreColdImageV1({...restore,backupFile:corrupt}),/COLD_IMAGE_AUTHENTICATION/);await assert.rejects(lstat(cluster.target),{code:'ENOENT'});
 const occupied=join(work,'occupied');await mkdir(occupied);await writeFile(join(occupied,'sentinel.txt'),'preserve this existing target');await assert.rejects(restoreColdImageV1({...restore,targetDirectory:occupied}),/COLD_IMAGE_TARGET_EXISTS/);assert.equal(await readFile(join(occupied,'sentinel.txt'),'utf8'),'preserve this existing target');
 note('wrong key and corrupted image fail before creating target; a preexisting target is refused and its sentinel bytes remain unchanged');
 report.restore=await restoreColdImageV1(restore);assert.equal(report.restore.automaticActivationApproved,false);assert.equal(canonical(await coldStoppedV1(cluster.source,cluster.tooling,cluster.systemIdentifier)),canonical(cluster.sourceControl));await cluster.startRestored();
 const restoredAdmin=await connect(cluster.account),inventory=await coldRuntimeInventoryV1(restoredAdmin),expected=structuredClone(frozen);expected.identity.directory=inventory.identity.directory;assert.deepEqual(inventory,expected);await end(restoredAdmin);
 for(const d of databases){const c=await connect({...cluster.account,database:d.database});assert.deepEqual(await facts(c,d.loid),d.before);assert.equal(await coldRuntimeStructureV1(c),d.structure);const gate=(await c.query('SELECT * FROM runtime_write_fence_v1._state')).rows[0],epoch=(await c.query('SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS value FROM runtime_write_fence_v1._ddl_epoch')).rows[0].value;assert.equal(gate.catalog_hash,d.binding.catalogHash);assert.equal(gate.state,'CLOSED');assert.equal(gate.ddl_epoch,epoch);assert.equal(gate.finalized,true);await end(c);await assert.rejects(connect({...cluster.account,database:d.database,user:app,password}),e=>e.code==='28000');}
 report.unchangedDatabases=databases.length;report.sourceRemainsOffline=true;report.restoredAppLoginDenied=true;report.catalogsRebased=false;
 note('actual restored PostgreSQL starts while source remains offline; original sysid/OIDs/roles/ACL/catalog hashes, rows, sequences and large objects match; SQL gates stay CLOSED and APP login denied');
 report.passed=true;
}catch(e){problem=e;report.failure={code:e.code??null,message:e.message};if(process.env.GITHUB_ACTIONS==='true')console.log('::error title=Physical PostgreSQL verification failed::'+String(e.message).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));
}finally{
 const errors=[];for(const c of [...clients])try{await end(c);}catch(e){errors.push(e.message);}
 if(cluster?.active){try{const c=await cluster.client();let inventory;try{inventory=await coldRuntimeInventoryV1(c);for(const row of inventory.databases)assert(report.resources.some(r=>r.type==='database'&&r.oid===row.oid&&r.name===row.datname&&r.owner===report.resources.find(x=>x.type==='role'&&x.oid===row.datdba)?.name));for(const role of inventory.roles)assert(report.resources.some(r=>r.type==='role'&&r.oid===role.oid&&r.name===role.rolname));assert.equal(inventory.databases.length,report.resources.filter(r=>r.type==='database').length);assert.equal(inventory.roles.length,report.resources.filter(r=>r.type==='role').length);}finally{await c.end();}report.cleanup.sql=await cleanupRuntimeColdSqlV1(cluster.account,inventory);}catch(e){errors.push(e.message);}try{await cluster.stop();}catch(e){errors.push(e.message);}}
 report.cleanup.errors=errors;report.cleanup.processes=cluster?.processes??[];report.cleanup.offlineSourceAndPrivateEvidenceRetained=true;report.cleanup.encryptedImageRetained=!!report.backup;if(errors.length)report.passed=false;
 for(const p of pins)assert.equal(sha(await readFile(p.path)),p.sha256,'PLATFORM_QA_SOURCE_CHANGED');
 if(work)await privateNewFile(join(work,'verification.json'),canonical(report));
 const publicResult={passed:report.passed,platform:report.platform,postgresVersion:version,checks:report.checks.length,sourcePins:pins.length,unchangedDatabases:report.unchangedDatabases??0,restoredAppLoginDenied:report.restoredAppLoginDenied??false,sourceRemainsOffline:report.sourceRemainsOffline??false,catalogsRebased:report.catalogsRebased??false,backup:report.backup,cleanup:report.cleanup,fullRuntimeAdmissionTested:false};
 console.log(JSON.stringify(publicResult));if(process.env.GITHUB_STEP_SUMMARY)await writeFile(process.env.GITHUB_STEP_SUMMARY,'```json\n'+JSON.stringify(publicResult,null,2)+'\n```\n',{flag:'a'});
}if(problem)throw problem;if(!report.passed)process.exitCode=1;
