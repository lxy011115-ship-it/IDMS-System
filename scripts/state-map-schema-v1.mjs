import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const ident=v=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(v))throw Error('STATE_MAP_IDENTIFIER');return '"'+v+'"';};
const literal=v=>"'"+v.replaceAll("'","''")+"'";
export async function stateMapSchemaSql({tenant,owner,app,reader}){
 if(!/^[a-z][a-z0-9_-]{0,63}$/.test(tenant)||new Set([owner,app,reader]).size!==3)throw Error('STATE_MAP_INSTALL_CONFIG');
 let sql=await readFile(new URL('./state-map-v1.sql',import.meta.url),'utf8');
 for(const [key,value] of Object.entries({OWNER:ident(owner),APP:ident(app),READER:ident(reader),OWNER_LITERAL:literal(owner),APP_LITERAL:literal(app),READER_LITERAL:literal(reader),TENANT:literal(tenant)}))sql=sql.replaceAll('__'+key+'__',value);
 if(/__[A-Z_]+__/.test(sql))throw Error('STATE_MAP_TEMPLATE');return sql;
}
export {inspectStateMapCatalog} from '../server/state-map-catalog-v1.ts';
