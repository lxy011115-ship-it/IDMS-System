import {readFile} from 'node:fs/promises';
import {governanceConsoleSchemaSqlV4} from './governance-console-schema-v4.mjs';
/** Fresh namespace only; existing governance and maintenance catalogs are preserved. */
export async function predictiveJobsSchemaSqlV4(options){
 let sql=(await governanceConsoleSchemaSqlV4(options))
  .replaceAll('governance_jobs_v4','predictive_jobs_v4').replaceAll('governance_queue_','predictive_queue_')
  .replaceAll('GOVERNANCE_','PREDICTIVE_').replaceAll('CONSOLE_','PREDICTIVE_')
  .replaceAll('1229213011,2','1229213011,6')
  .replaceAll("'TEMPLATE_CREATE','TEMPLATE_EDIT','TEMPLATE_SUBMIT','TEMPLATE_APPROVE','IMPORT_CREATE','IMPORT_APPROVE'","'ANALYZE','REVIEW'");
 let extra=await readFile(new URL('./predictive-jobs-v4.sql',import.meta.url),'utf8');extra+='\n'+await readFile(new URL('./predictive-controls-v4.sql',import.meta.url),'utf8');
 for(const key of ['owner','worker','ingress']){
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(options[key]))throw Error('PREDICTIVE_INSTALL_ROLE');
  extra=extra.replaceAll('__'+key.toUpperCase()+'__','"'+options[key]+'"');
 }
 const marker='CREATE EVENT TRIGGER predictive_queue_ddl_start_v4',parts=sql.split(marker);
 if(parts.length!==2)throw Error('PREDICTIVE_INSTALL_INSERTION');
 return parts[0]+extra+'\n'+marker+parts[1];
}
