import {readFile} from 'node:fs/promises';
import {governanceConsoleSchemaSqlV4} from './governance-console-schema-v4.mjs';
/** Fresh additional namespace. Existing governance/AI protocols and catalogs stay unchanged. */
export async function maintenanceJobsSchemaSqlV4(options){
 let sql=(await governanceConsoleSchemaSqlV4(options)).replaceAll('governance_jobs_v4','maintenance_jobs_v4').replaceAll('governance_queue_','maintenance_queue_').replaceAll('GOVERNANCE_','MAINTENANCE_').replaceAll('CONSOLE_','MAINTENANCE_').replaceAll('1229213011,2','1229213011,5').replaceAll("'TEMPLATE_CREATE','TEMPLATE_EDIT','TEMPLATE_SUBMIT','TEMPLATE_APPROVE','IMPORT_CREATE','IMPORT_APPROVE'","'claim','start','submit','approval','workflow/retry'");
 let extra=await readFile(new URL('./maintenance-jobs-v4.sql',import.meta.url),'utf8');for(const key of ['owner','worker','ingress']){if(!/^[a-z][a-z0-9_]{0,62}$/.test(options[key]))throw Error('MAINTENANCE_INSTALL_ROLE');extra=extra.replaceAll('__'+key.toUpperCase()+'__','"'+options[key]+'"');}
 const marker='CREATE EVENT TRIGGER maintenance_queue_ddl_start_v4',parts=sql.split(marker);if(parts.length!==2)throw Error('MAINTENANCE_INSTALL_INSERTION');return parts[0]+extra+'\n'+marker+parts[1];
}
