import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {flags,restoreTenantBackup} from './backup-support.mjs';

const args=flags(process.argv.slice(2),['--tenant','--key-file','--backup-file','--target-database','--credential-file','--config']);
for(const name of ['--tenant','--key-file','--backup-file','--target-database','--credential-file'])if(!args[name])throw Error('Missing required argument: '+name);
const config=JSON.parse(await readFile(resolve(args['--config']||'.local/postgres-runtime.json'),'utf8'));
console.log(JSON.stringify(await restoreTenantBackup({config,tenantId:args['--tenant'],keyFile:args['--key-file'],backupFile:args['--backup-file'],targetDatabase:args['--target-database'],credentialFile:args['--credential-file']}),null,2));
