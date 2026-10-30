import {verifySparesDatabase} from '../server/spares-db.ts';
import {readEntities} from '../server/entity-repository.ts';
import {verifyDataProjection} from '../server/data-projection.ts';
import {verifyBatchMapping} from '../server/catalog.ts';
import {verifyEquipmentCatalog} from '../server/equipment-profiles.ts';
import {readFile,writeFile,mkdir,lstat,unlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,randomUUID,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import pg from 'pg';
import {verifyAuditChain} from '../server/audit.ts';
import {canonical} from '../server/imports.ts';
import {captureSparesBackupAnchor} from './spares-backup-anchor.mjs';
import {validateBusinessBackupManifest} from './business-backup-manifest.mjs';

const exec=promisify(execFile),magic=Buffer.from('IDMSBKP1'),maxDump=128*1024*1024,maxManifest=256*1024;
const maxArchive=maxDump+maxManifest+56;
const quote=value=>'"'+String(value).replaceAll('"','""')+'"';
const digest=value=>createHash('sha256').update(value).digest('hex');
const validTenant=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(value);
export function flags(args,allowed){
  const parsed={};
  for(let i=0;i<args.length;i+=2){const name=args[i];if(!allowed.includes(name)||Object.hasOwn(parsed,name)||!args[i+1]||args[i+1].startsWith('--'))throw Error('Invalid or duplicate command argument');parsed[name]=args[i+1];}
  return parsed;
}
async function rejectSymlinks(path){
  let current=resolve(path);
  for(;;){try{if((await lstat(current)).isSymbolicLink())throw Error('Symbolic links are not allowed for private backup paths');}catch(e){if(e.code!=='ENOENT')throw e;}const next=dirname(current);if(next===current)break;current=next;}
}
export async function privateDirectory(path){
  await rejectSymlinks(path);await mkdir(path,{recursive:true,mode:0o700});
  if(process.platform==='win32')await exec('icacls.exe',[resolve(path),'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)(F)`],{windowsHide:true});
}
export async function privateNewFile(path,value){
  await rejectSymlinks(path);await privateDirectory(dirname(path));
  await writeFile(path,value,{flag:'wx',mode:0o600,flush:true});
  try{if(process.platform==='win32')await exec('icacls.exe',[resolve(path),'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`],{windowsHide:true});}
  catch(e){await unlink(path).catch(()=>{});throw e;}
}
export async function generateKey(file){
  const value={format:1,keyId:randomUUID(),key:randomBytes(32).toString('base64')};
  await privateNewFile(file,JSON.stringify(value));return {keyId:value.keyId,file:resolve(file)};
}
export async function readKey(file){
  await rejectSymlinks(file);const info=await lstat(file);if(!info.isFile()||info.size>1024)throw Error('Invalid backup key file');
  const value=JSON.parse(await readFile(file,'utf8'));
  if(value.format!==1||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.keyId)||typeof value.key!=='string'||Buffer.from(value.key,'base64').length!==32)throw Error('Invalid backup key format');
  return {...value,bytes:Buffer.from(value.key,'base64')};
}
export function sealBackup(manifest,dump,key){
  const metadata=Buffer.from(JSON.stringify(manifest));
  if(metadata.length>maxManifest||dump.length>maxDump||dump.subarray(0,5).toString()!=='PGDMP')throw Error('Backup payload format or size is invalid');
  const header=Buffer.concat([magic,Buffer.from(key.keyId.replaceAll('-',''),'hex'),randomBytes(12)]),length=Buffer.alloc(4);length.writeUInt32BE(metadata.length);
  const cipher=createCipheriv('aes-256-gcm',key.bytes,header.subarray(24));cipher.setAAD(header);
  return Buffer.concat([header,cipher.update(length),cipher.update(metadata),cipher.update(dump),cipher.final(),cipher.getAuthTag()]);
}
export function openBackup(archive,key,tenantId){
  if(!validTenant(tenantId)||archive.length<61||archive.length>maxArchive||!archive.subarray(0,8).equals(magic))throw Error('Unsupported backup format, tenant or size');
  const header=archive.subarray(0,36);
  if(header.subarray(8,24).toString('hex')!==key.keyId.replaceAll('-',''))throw Error('Backup key does not match');
  let plaintext;
  try{const cipher=createDecipheriv('aes-256-gcm',key.bytes,header.subarray(24));cipher.setAAD(header);cipher.setAuthTag(archive.subarray(-16));plaintext=Buffer.concat([cipher.update(archive.subarray(36,-16)),cipher.final()]);}
  catch{throw Error('Backup authentication failed; no database restore was attempted');}
  const length=plaintext.readUInt32BE(0);if(length<2||length>maxManifest||length>plaintext.length-9)throw Error('Invalid authenticated backup manifest');
  let manifest;try{manifest=JSON.parse(plaintext.subarray(4,4+length).toString('utf8'));}catch{throw Error('Invalid authenticated backup manifest');}const dump=plaintext.subarray(4+length);
  if(!manifest||![1,2].includes(manifest.format)||manifest.scope!=='TENANT_BUSINESS_DATABASE'||manifest.recoveryMode!=='ISOLATED_BUSINESS_ONLY'||manifest.tenantId!==tenantId||manifest.schemaVersion!==2||!Array.isArray(manifest.facts)||manifest.facts.length>1000||dump.length>maxDump||dump.subarray(0,5).toString()!=='PGDMP'||digest(dump)!==manifest.dumpSha256)throw Error('Backup tenant, manifest or dump does not match');
  if(manifest.format===2)validateBusinessBackupManifest(manifest);
  return {manifest,dump};
}
async function command(program,args,account,config,input){
  return new Promise((ok,fail)=>{
    const child=spawn(program,args,{env:{...process.env,PGHOST:config.host,PGPORT:String(config.port),PGUSER:account.user,PGPASSWORD:account.password,PGDATABASE:account.database,PGCONNECT_TIMEOUT:'10',PGAPPNAME:'idms-backup-recovery'},stdio:['pipe','pipe','pipe'],windowsHide:true});
    const chunks=[];let size=0,problem;
    const timer=setTimeout(()=>{problem=Error('Owned PostgreSQL backup command exceeded its time limit');child.kill();},120000);
    child.once('error',()=>{clearTimeout(timer);fail(Error('Cannot launch PostgreSQL backup utility'));});
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxDump){problem=Error('Backup exceeds the current 128 MiB compressed development limit');child.kill();}else chunks.push(chunk);});
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.once('close',code=>{clearTimeout(timer);if(problem)fail(problem);else if(code!==0)fail(Error('PostgreSQL backup utility failed; no credentials or SQL were logged'));else ok(Buffer.concat(chunks));});
    child.stdin.end(input);
  });
}
function executable(name){return join(process.env.LOCALAPPDATA,'IDMS/runtime/pgsql/bin',name+(process.platform==='win32'?'.exe':''));}
async function version(client){const value=(await client.query('SHOW server_version_num')).rows[0].server_version_num;if(!/^16\d{4}$/.test(value))throw Error('This recovery tool currently requires PostgreSQL 16');return value;}
export async function databaseFacts(client){
  const tables=(await client.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','idms_spares') ORDER BY schemaname COLLATE \"C\",tablename COLLATE \"C\"")).rows;
  if(!tables.length||tables.length>1000)throw Error('Unexpected database schema size');
  const facts=[];
  for(const {schemaname,tablename} of tables){
    const columns=(await client.query("SELECT column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$2 AND table_name=$1 ORDER BY ordinal_position",[tablename,schemaname])).rows;
    const hash=createHash('sha256');let count=0;
    await new Promise((ok,fail)=>{const q=client.query(new pg.Query(`SELECT to_jsonb(t)::text AS record FROM ${quote(schemaname)}.${quote(tablename)} t ORDER BY to_jsonb(t)::text COLLATE "C"`));q.on('row',(row,result)=>{if(result)result.rows.length=0;hash.update(row.record+'\n');count++;});q.once('error',fail);q.once('end',ok);});
    facts.push({table:schemaname==='public'?tablename:schemaname+'.'+tablename,columns,rows:count,sha256:hash.digest('hex')});
  }
  return facts;
}
export async function validateBusinessDatabase(client,tenantId,{normalized=false}={}){
  const result=await client.query('SELECT schema_version,payload FROM runtime_state WHERE singleton=true');
  if(result.rowCount!==1||result.rows[0].schema_version!==2)throw Error('Expected one version-2 tenant runtime snapshot');
  let payload=result.rows[0].payload;
  if((await client.query("SELECT to_regclass('public.business_state') AS name")).rows[0].name){const current=await readEntities(client,tenantId);if(normalized)payload=current.payload;}
  for(const [name,items] of Object.entries(payload.business))if(!Array.isArray(items)||items.some(item=>name==='tenants'?item.id!==tenantId:item.tenantId!==tenantId))throw Error('Business snapshot tenant mismatch');
  for(const name of ['batches','records'])if(payload.imports[name].some(item=>item.tenantId!==tenantId))throw Error('Import tenant mismatch');
  if(payload.imports.requests.some(item=>!item.key.startsWith(tenantId+':'))||payload.idempotency.some(([key])=>!key.startsWith(tenantId+':'))||payload.audits.some(item=>item.tenantId!==tenantId)||!verifyAuditChain(payload.audits,tenantId))throw Error('Tenant or audit chain validation failed');
  const entries=(await client.query('SELECT event_id,tenant_id,hash,previous_hash,event FROM audit_ledger ORDER BY sequence_no')).rows;
  if(entries.some(row=>row.event_id!==row.event.eventId||row.tenant_id!==row.event.tenantId||row.hash!==row.event.hash||row.previous_hash!==row.event.previousHash))throw Error('SQL audit columns disagree with their frozen events');
  const ledger=entries.map(row=>row.event);
  if(canonical(ledger)!==canonical(payload.audits))throw Error('SQL ledger differs from business audit history');
  const store={...payload.business,audits:payload.audits,idempotency:new Map(payload.idempotency)};verifyEquipmentCatalog(store);for(const batch of payload.imports.batches)verifyBatchMapping(store,batch);
  if((await client.query("SELECT to_regclass('public.managed_record_revisions') AS name")).rows[0].name)await verifyDataProjection(client,payload.imports,tenantId);
  else if(payload.imports.batches.some(b=>b.correction))throw Error('Correction SQL ledger is missing');
  for(const batch of payload.imports.batches)if(typeof batch.originalBase64!=='string'||digest(Buffer.from(batch.originalBase64,'base64'))!==batch.fileSha256)throw Error('Original import file checksum mismatch');
  const tenantTables=(await client.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'")).rows;
  for(const {table_name} of tenantTables)if((await client.query(`SELECT 1 FROM public.${quote(table_name)} WHERE tenant_id IS DISTINCT FROM $1 LIMIT 1`,[tenantId])).rowCount)throw Error('A SQL table contains foreign tenant data');
  await verifySparesDatabase(client,tenantId);
  return {batches:payload.imports.batches.length,records:payload.imports.records.length,auditEvents:payload.audits.length,workOrders:payload.business.workOrders.length,importsDigest:digest(canonical(payload.imports)),businessDigest:digest(canonical(payload.business))};
}
export async function createTenantBackup({config,tenantId,keyFile,outputDirectory}){
  if(!validTenant(tenantId)||!Object.hasOwn(config.tenants,tenantId))throw Error('Unknown configured tenant');
  if(config.purpose==='BUSINESS_RUNTIME'||config.purpose==='BUSINESS_MIGRATION')throw Error('Backup requires its dedicated read-only or deployment configuration');
  const key=await readKey(keyFile),account=config.businessRoles?.[tenantId]?.backup||config.tenants[tenantId],client=new pg.Client({host:config.host,port:config.port,user:account.user,password:account.password,database:account.database,connectionTimeoutMillis:10000});
  let output,created=false;
  await client.connect();
  try{
    await beginBackupSnapshot(client);
    const pgVersion=await version(client),snapshot=(await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const checks=await validateBusinessDatabase(client,tenantId,{normalized:true}),spares=await captureSparesBackupAnchor(client,tenantId),facts=await databaseFacts(client);
    const dump=await command(executable('pg_dump'),['--format=custom','--no-owner','--no-acl','--no-password','--snapshot='+snapshot],account,config);
    const manifest={format:2,backupId:randomUUID(),tenantId,createdAt:new Date().toISOString(),sourceDatabase:account.database,pgVersion,schemaVersion:2,scope:'TENANT_BUSINESS_DATABASE',recoveryMode:'ISOLATED_BUSINESS_ONLY',excluded:['identity-database','flowable-database','gateway-receipts','edge-cache','deployment-secrets','model-files'],facts,checks,spares,dumpSha256:digest(dump)};
    validateBusinessBackupManifest(manifest);const archive=sealBackup(manifest,dump,key);await privateDirectory(outputDirectory);
    output=join(resolve(outputDirectory),tenantId+'-'+manifest.backupId+'.idmsbackup');
    await privateNewFile(output,archive);created=true;await client.query('COMMIT');
    return {backupId:manifest.backupId,tenantId,file:output,encryptedBytes:archive.length,tables:facts.length,checks,spares,manifestFormat:2,compressedDumpLimitBytes:maxDump,scope:manifest.scope,recoveryMode:manifest.recoveryMode,productionAcceptance:false};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});if(created)await unlink(output).catch(()=>{});throw e;}finally{await client.end();}
}
export async function restoreTenantBackup({config,tenantId,keyFile,backupFile,targetDatabase,credentialFile,ownership}){
  if(!validTenant(tenantId)||typeof targetDatabase!=='string'||targetDatabase.length>63||!new RegExp('^idms_restore_'+tenantId.replaceAll('-','_')+'_[0-9a-f]{12}$').test(targetDatabase))throw Error('Restore requires an explicitly named new isolated database');
  await rejectSymlinks(backupFile);const info=await lstat(backupFile);if(!info.isFile()||info.size>maxArchive)throw Error('Backup file exceeds supported size');
  // Authenticate the complete archive before even connecting to the administrative database.
  const {manifest,dump}=openBackup(await readFile(backupFile),await readKey(keyFile),tenantId);
  const admin=new pg.Client({host:config.host,port:config.port,user:'idms_bootstrap',password:config.bootstrapPassword,database:'postgres',connectionTimeoutMillis:10000});
  let client;
  await admin.connect();
  try{
    await version(admin);
    const exists=await admin.query('SELECT 1 FROM pg_database WHERE datname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=$1',[targetDatabase]);
    if(exists.rowCount)throw Error('Restore target already exists; refusing to replace it');
    const account={user:targetDatabase,database:targetDatabase,password:randomBytes(32).toString('base64url')};
    // Save the recovery-only credentials first, with exclusive creation. No live config is changed.
    await privateNewFile(credentialFile,JSON.stringify({purpose:'ISOLATED_BUSINESS_ONLY',tenantId,backupId:manifest.backupId,host:config.host,port:config.port,...account}));
    await admin.query(`CREATE ROLE ${quote(account.user)} LOGIN PASSWORD '${account.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    if(ownership)ownership.roleCreated=true;
    await admin.query(`CREATE DATABASE ${quote(account.database)} OWNER ${quote(account.user)} TEMPLATE template0`);
    if(ownership)ownership.databaseCreated=true;
    await admin.query(`REVOKE CONNECT ON DATABASE ${quote(account.database)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${quote(account.database)} TO ${quote(account.user)}`);
    await command(executable('pg_restore'),['--dbname='+targetDatabase,'--no-owner','--no-acl','--no-password','--exit-on-error','--single-transaction'],account,config,dump);
    client=new pg.Client({host:config.host,port:config.port,...account});await client.connect();
    await beginBackupSnapshot(client,manifest.format===2);const facts=await databaseFacts(client),checks=await validateBusinessDatabase(client,tenantId,{normalized:manifest.format===2}),spares=manifest.format===2?await captureSparesBackupAnchor(client,tenantId):undefined;
    if(canonical(facts)!==canonical(manifest.facts)||canonical(checks)!==canonical(manifest.checks))throw Error('Restored content differs from authenticated source snapshot; target remains isolated');
    if(manifest.format===2&&canonical(spares)!==canonical(manifest.spares))throw Error('Restored spares continuity anchor differs from authenticated source; target remains isolated');await client.query('COMMIT');
    return {backupId:manifest.backupId,tenantId,targetDatabase,credentialFile:resolve(credentialFile),tables:facts.length,checks,...(spares?{spares}:{}),manifestFormat:manifest.format,verified:true,recoveryMode:'ISOLATED_BUSINESS_ONLY',liveConfigurationChanged:false,productionAcceptance:false};
  }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});throw e;}finally{await client?.end();await admin.end();}
}

async function beginBackupSnapshot(client,normalizedText=true){
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await client.query("SET LOCAL search_path=pg_catalog,public;SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='120s'");
 if(normalizedText)await client.query("SET LOCAL TimeZone='UTC';SET LOCAL DateStyle='ISO, YMD';SET LOCAL bytea_output='hex';SET LOCAL extra_float_digits=3");
}
