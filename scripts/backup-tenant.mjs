import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {flags,generateKey,createTenantBackup} from './backup-support.mjs';

const args=flags(process.argv.slice(2),['--tenant','--key-file','--output-dir','--config','--generate-key']);
if(args['--generate-key']){
  if(Object.keys(args).length!==1)throw Error('Key generation must be a separate command');
  const result=await generateKey(args['--generate-key']);console.log(JSON.stringify({keyId:result.keyId,file:result.file,keyMaterialLogged:false}));
}else{
  if(!args['--tenant']||!args['--key-file'])throw Error('Required: --tenant TENANT --key-file PRIVATE_KEY_FILE');
  const config=JSON.parse(await readFile(resolve(args['--config']||'.local/postgres-backup.json'),'utf8'));
  const result=await createTenantBackup({config,tenantId:args['--tenant'],keyFile:args['--key-file'],outputDirectory:args['--output-dir']||'.local/backups'});
  console.log(JSON.stringify(result,null,2));
}
