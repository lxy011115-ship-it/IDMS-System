import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {stateMapSchemaSqlV3} from './state-map-schema-v3.mjs';
/** Fresh queue-hosted schema: workers stage, but only a live queue claim may publish. */
export async function stateMapSchemaSqlV4(options){
 const bytes=await readFile(new URL('./state-map-schema-v3.mjs',import.meta.url));if(createHash('sha256').update(bytes).digest('hex')!=='a4d38b1add10484f811533c187256e0395576649566298b58e30fa2d4d6e650b')throw Error('STATE_MAP_V4_BASE_CHANGED');
 const sql=await stateMapSchemaSqlV3(options),fragment=',state_map_v1.publish_branch_v1(text,uuid,uuid,bigint,bytea,bigint,bytea,bytea)';
 if(sql.split(fragment).length!==2)throw Error('STATE_MAP_V4_PRIVILEGE_BOUNDARY');return sql.replace(fragment,'');
}
