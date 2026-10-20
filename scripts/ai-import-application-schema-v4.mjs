import {readFile} from 'node:fs/promises';
import {governanceConsoleSchemaSqlV4} from './governance-console-schema-v4.mjs';
import {aiReviewTransportSchemaV4} from './ai-review-transport-schema-v4.mjs';
/** Fresh combined deployment only; all extensions precede both non-MVCC DDL guards. */
export async function aiImportApplicationSchemaV4(options){
 for(const key of ['owner','worker','ingress'])if(!/^[a-z][a-z0-9_]{0,62}$/.test(options[key]))throw Error('AI_IMPORT_INSTALL_ROLE');
 const gov=await governanceConsoleSchemaSqlV4(options),ai=await aiReviewTransportSchemaV4({owner:options.owner,app:options.worker,tenant:options.tenant,deployment:options.deployment,keyCheck:options.keyCheck}),g=gov.split('CREATE EVENT TRIGGER governance_queue_ddl_start_v4'),a=ai.split('CREATE EVENT TRIGGER ai_review_ddl_start_v4');if(g.length!==2||a.length!==2)throw Error('AI_IMPORT_INSTALL_BOUNDARY');
 let extra=await readFile(new URL('./ai-import-application-v4.sql',import.meta.url),'utf8');for(const [key,value]of Object.entries({OWNER:'"'+options.owner+'"',APP:'"'+options.worker+'"'}))extra=extra.replaceAll('__'+key+'__',value);if(/__[A-Z_]+__/.test(extra))throw Error('AI_IMPORT_INSTALL_TEMPLATE');
 return g[0]+a[0]+extra+'CREATE EVENT TRIGGER ai_review_ddl_start_v4'+a[1]+'CREATE EVENT TRIGGER governance_queue_ddl_start_v4'+g[1];
}
