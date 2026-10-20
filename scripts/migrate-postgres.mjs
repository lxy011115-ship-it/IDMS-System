import {readFile,writeFile,rename,chmod,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {roleLayout,businessRuntime,backupRuntime,migrationRuntime,migrateTenant} from './database-migrations.mjs';
import {flags,privateDirectory} from './backup-support.mjs';

const args=flags(process.argv.slice(2),['--config','--business-config','--backup-config','--migration-config','--telemetry-tenants']);
if(process.env.IDMS_STORAGE==='postgres')throw Error('Run migrations in a dedicated deployment process, not the business runtime');
const file=resolve(args['--config']||'.local/postgres-runtime.json');
const businessFile=resolve(args['--business-config']||'.local/postgres-business.json');
const backupFile=resolve(args['--backup-config']||'.local/postgres-backup.json');
const migrationFile=resolve(args['--migration-config']||'.local/postgres-migration.json');
const paths=[file,businessFile,backupFile,migrationFile].map(p=>process.platform==='win32'?p.toLowerCase():p);
if(new Set(paths).size!==paths.length)throw Error('Deployment, migration, business and backup configuration paths must be distinct');
const config=JSON.parse(await readFile(file,'utf8'));
const telemetry=args['--telemetry-tenants']===undefined?null:args['--telemetry-tenants'].split(',').filter(Boolean);
if(telemetry?.some(t=>!Object.hasOwn(config.tenants,t)))throw Error('Unknown telemetry tenant');
config.businessRoles??={};
for(const [tenant,a]of Object.entries(config.tenants)){
  config.businessRoles[tenant]??=roleLayout(a);
  if(telemetry)config.businessRoles[tenant].telemetry=telemetry.includes(tenant);
  else config.businessRoles[tenant].telemetry??=false;
}
const exec=promisify(execFile);
async function savePrivate(path,value){
  path=resolve(path);await privateDirectory(dirname(path));
  try{if((await lstat(path)).isSymbolicLink())throw Error('Private configuration must not be a symbolic link');}catch(e){if(e.code!=='ENOENT')throw e;}
  const temporary=path+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600,flush:true});
  if(process.platform==='win32')await exec('icacls.exe',[temporary,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`],{windowsHide:true});
  await rename(temporary,path);await chmod(path,0o600);
}
// Persist generated deployment identities before using them; retries must keep passwords.
await savePrivate(file,config);
const {seedStore}=await import('../server/store.ts');
const {loadImports,platformSnapshot}=await import('../server/import-api.ts');
const store=seedStore();await loadImports(store);const snapshot=platformSnapshot(store);
const results=[];
for(const tenantId of Object.keys(config.tenants))results.push(await migrateTenant(config,tenantId,snapshot));
await savePrivate(migrationFile,migrationRuntime(config));
await savePrivate(backupFile,backupRuntime(config));
await savePrivate(businessFile,businessRuntime(config));
console.log(JSON.stringify({status:'migrated',results,businessFile,credentialsLogged:false,productionAcceptance:false}));
