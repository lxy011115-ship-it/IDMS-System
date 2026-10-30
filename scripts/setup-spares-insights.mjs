import {readFile,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import pg from 'pg';
import {flags,readKey,openBackup,validateBusinessDatabase} from './backup-support.mjs';
import {migrateSparesInsights} from './spares-insights-migration.mjs';

const args=flags(process.argv.slice(2),['--tenant','--backup','--key-file','--config','--business-config']);
const tenantId=args['--tenant'];if(!tenantId||!args['--backup']||!args['--key-file'])throw Error('Required: --tenant TENANT --backup ENCRYPTED_ARCHIVE --key-file PRIVATE_KEY_FILE');
async function privateInput(name,max){const path=resolve(name);for(let p=path;;p=dirname(p)){const s=await lstat(p);if(s.isSymbolicLink())throw Error('Linked migration input refused');if(p===dirname(p))break;}const s=await lstat(path);if(!s.isFile()||s.size>max)throw Error('Migration input type or size invalid');return readFile(path);}
const config=JSON.parse(await privateInput(args['--config']||'.local/postgres-migration.json',256*1024)),business=JSON.parse(await privateInput(args['--business-config']||'.local/postgres-business.json',256*1024));
const account=config.tenants?.[tenantId],runtime=business.tenants?.[tenantId];
if(config.purpose!=='BUSINESS_MIGRATION'||business.purpose!=='BUSINESS_RUNTIME'||!account||!runtime||config.host!==business.host||config.port!==business.port||account.database!==runtime.database||account.user===runtime.user||!runtime.backupRole)throw Error('Dedicated migration configuration and exact tenant binding required');
// Authentication happens before connecting; decrypted dump never reaches disk.
const opened=openBackup(await privateInput(args['--backup'],128*1024*1024+256*1024+56),await readKey(args['--key-file']),tenantId),manifest=opened.manifest;
if(manifest.format!==2||manifest.sourceDatabase!==account.database)throw Error('An authenticated version-2 backup of this source database is required');
opened.dump.fill(0);delete opened.dump;
const client=new pg.Client({host:config.host,port:config.port,user:account.user,password:account.password,database:account.database,connectionTimeoutMillis:10000});
await client.connect();try{
 const result=await migrateSparesInsights({client,tenantId,ownerRole:account.ownerRole||runtime.ownerRole,appRole:runtime.user,backupRole:runtime.backupRole,backup:manifest,verifyCurrent:c=>validateBusinessDatabase(c,tenantId,{normalized:true})});
 console.log(JSON.stringify({...result,backupId:manifest.backupId,identityOrLiveConfigurationChanged:false},null,2));
}finally{await client.end();}
