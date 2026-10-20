import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
const exec = promisify(execFile), root = join(process.env.LOCALAPPDATA, 'IDMS/runtime');
const bin = join(root, 'pgsql/bin'), data = join(root, 'postgres-data'), configDir = resolve('.local');
const file = join(configDir, 'postgres-runtime.json');
await mkdir(configDir, {recursive:true});
let config;
try { config = JSON.parse(await readFile(file, 'utf8')); }
catch (e) {
  if (e.code!=='ENOENT') throw e;
  config = {port:55432, host:'127.0.0.1', bootstrapPassword:randomBytes(32).toString('base64url'), tenants:{}, workflowTenants:{}, control:{user:'idms_control_app',password:randomBytes(32).toString('base64url'),database:'idms_control'}};
  for (const tenantId of ['acme','sandbox']) {
    config.tenants[tenantId] = {user:'idms_'+tenantId+'_app',password:randomBytes(32).toString('base64url'),database:'idms_'+tenantId};
    config.workflowTenants[tenantId] = {user:'idms_'+tenantId+'_workflow',password:randomBytes(32).toString('base64url'),database:'idms_'+tenantId+'_workflow'};
  }
  await writeFile(file, JSON.stringify(config), {mode:0o600});
  await chmod(file, 0o600);
  if (process.platform==='win32') await exec('icacls.exe',[file,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`],{windowsHide:true});
}
// Older local configurations predate the dedicated workflow databases. Add only the
// generated accounts/databases; never replace existing credentials or business data.
config.workflowTenants ??= {};
for (const tenantId of Object.keys(config.tenants)) {
  config.workflowTenants[tenantId] ??= {user:'idms_'+tenantId+'_workflow',password:randomBytes(32).toString('base64url'),database:'idms_'+tenantId+'_workflow'};
}
await writeFile(file, JSON.stringify(config), {mode:0o600});
try { await readFile(join(data, 'PG_VERSION')); }
catch (e) {
  if (e.code!=='ENOENT') throw e;
  const pwFile=join(configDir, 'postgres-bootstrap-password');
  await writeFile(pwFile, config.bootstrapPassword, {mode:0o600});
  if (process.platform==='win32') await exec('icacls.exe',[pwFile,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`],{windowsHide:true});
  const result=await exec(join(bin,'initdb.exe'),['-D',data,'-U','idms_bootstrap','-A','scram-sha-256','--pwfile',pwFile,'--encoding=UTF8','--locale=C'],{windowsHide:true});
  console.log(result.stdout);
}
const status=await exec(join(bin,'pg_ctl.exe'),['status','-D',data],{windowsHide:true}).catch(()=>null);
if (!status) {
  // PostgreSQL child processes must not inherit execFile pipes on Windows.
  const start=spawn(join(bin,'pg_ctl.exe'),['start','-D',data,'-l',join(root,'postgres.log'),'-o',`-p ${config.port} -h 127.0.0.1`,'-w'],{windowsHide:true,stdio:'ignore'});
  await new Promise((ok,fail)=>{start.once('error',fail);start.once('exit',code=>code===0?ok():fail(Error('PostgreSQL startup failed; inspect postgres.log')));});
}
const admin=new pg.Client({host:config.host,port:config.port,user:'idms_bootstrap',password:config.bootstrapPassword,database:'postgres'});
await admin.connect();
try {
  for (const account of [config.control,...Object.values(config.tenants),...Object.values(config.workflowTenants)]) {
    if (!/^[a-z_]+$/.test(account.user)||!/^[a-z_]+$/.test(account.database)) throw Error('Invalid runtime identifier');
    if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[account.user])).rowCount) {
      if (!/^[\w-]+$/.test(account.password)) throw Error('Invalid generated password');
      await admin.query(`CREATE ROLE "${account.user}" LOGIN PASSWORD '${account.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    }
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[account.database])).rowCount) await admin.query(`CREATE DATABASE "${account.database}" OWNER "${account.user}"`);
    await admin.query(`REVOKE CONNECT ON DATABASE "${account.database}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${account.database}" TO "${account.user}"`);
  }
  console.log(JSON.stringify({status:'ready',host:config.host,port:config.port,version:(await admin.query('SHOW server_version')).rows[0].server_version,tenantDatabases:Object.values(config.tenants).map(t=>t.database),credentialFile:file,externalNetwork:false}));
} finally {await admin.end();}
