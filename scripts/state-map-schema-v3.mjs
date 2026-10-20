import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {stateMapSchemaSqlV2} from './state-map-schema-v2.mjs';
const pinnedV2='87c20c7fc7bf8d9c5aea92fe6ba77b1cdc61cfae5d2b338741c37c86cd838853';
const change=(source,from,to)=>{if(source.split(from).length!==2)throw Error('STATE_MAP_V3_SOURCE_BOUNDARY');return source.replace(from,()=>to);};
/** New databases only; no replacement of any existing schema or external catalog pin. */
export async function stateMapSchemaSqlV3(options){
 const file=await readFile(new URL('./state-map-schema-v2.mjs',import.meta.url));if(createHash('sha256').update(file).digest('hex')!==pinnedV2)throw Error('STATE_MAP_V3_BASE_CHANGED');
 let sql=await stateMapSchemaSqlV2(options),stage=sql.slice(sql.indexOf('CREATE FUNCTION state_map_v1.apply_delta_v1('),sql.indexOf('\nREVOKE ALL ON SCHEMA state_map_v1 FROM PUBLIC;'));
 stage=change(stage,'apply_delta_v1(tenant text,command uuid,','stage_branch_v1(tenant text,branch uuid,command uuid,');
 stage=change(stage,'DECLARE h state_map_v1.head;','DECLARE b state_map_v1.branch_heads;h state_map_v1.head;');
 stage=stage.replaceAll('PERFORM state_map_v1._assert_current(tenant,true);','PERFORM state_map_v1._branch_current(tenant,branch,true);');
 stage=change(stage,'request:=sha256(wire);',"request:=sha256(decode('09','hex')||uuid_send(branch)||sha256(wire));");
 stage=change(stage,'SELECT * INTO STRICT h FROM state_map_v1.head FOR UPDATE;',"SELECT * INTO STRICT b FROM state_map_v1.branch_heads WHERE branch_id=branch FOR UPDATE;\n b:=state_map_v1._branch_current(tenant,branch,true);h:=ROW(true,b.revision,b.root_id,b.root_hash,b.item_count,b.step_hash)::state_map_v1.head;");
 stage=change(stage,'SELECT * INTO old FROM state_map_v1.receipts WHERE command_id=command;','SELECT (s.body).* INTO old FROM state_map_v1.branch_steps s WHERE s.branch_id=branch AND s.command_id=command;');
 stage=stage.replaceAll('state_map_v1._receipt_hash(tenant,old)','state_map_v1._branch_receipt_hash(tenant,branch,old)');
 stage=change(stage,'RETURN state_map_v1._receipt_json(old,true);',"RETURN state_map_v1._receipt_json(old,true)||jsonb_build_object('branchId',branch::text,'format','STATE_MAP_BRANCH_V1');");
 stage=change(stage,'IF h.revision<>expected_revision',"IF b.published_command IS NOT NULL THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_PUBLISHED';END IF;\n IF h.revision<>expected_revision");
 stage=change(stage,'r.receipt_hash:=state_map_v1._receipt_hash(tenant,r);INSERT INTO state_map_v1.receipts SELECT r.*;','r.receipt_hash:=state_map_v1._branch_receipt_hash(tenant,branch,r);INSERT INTO state_map_v1.branch_steps VALUES(branch,command,r.revision,r.request_hash,r);');
 stage=change(stage,'UPDATE state_map_v1.head SET revision=r.revision,root_id=r.root_id,root_hash=r.root_hash,item_count=r.item_count,receipt_hash=r.receipt_hash;','UPDATE state_map_v1.branch_heads SET revision=r.revision,root_id=r.root_id,root_hash=r.root_hash,item_count=r.item_count,step_hash=r.receipt_hash WHERE branch_id=branch;');
 stage=change(stage,'out:=state_map_v1._receipt_json(r,false);',"out:=state_map_v1._receipt_json(r,false)||jsonb_build_object('branchId',branch::text,'format','STATE_MAP_BRANCH_V1');");
 const extension=change(await readFile(new URL('./state-map-branches-v1.sql',import.meta.url),'utf8'),'__STAGE_FUNCTION__',stage);
 sql=change(sql,'\nREVOKE ALL ON SCHEMA state_map_v1 FROM PUBLIC;',extension+'\nREVOKE ALL ON SCHEMA state_map_v1 FROM PUBLIC;');
 const ident=v=>'"'+v+'"',app=ident(options.app),reader=ident(options.reader);
 const grant=`GRANT EXECUTE ON FUNCTION state_map_v1.read_branch_v1(text,uuid),state_map_v1.read_branch_step_v1(text,uuid,uuid,bytea) TO ${app},${reader};
GRANT EXECUTE ON FUNCTION state_map_v1.begin_branch_v1(text,uuid,bigint,bytea),state_map_v1.stage_branch_v1(text,uuid,uuid,bigint,bytea,jsonb),state_map_v1.publish_branch_v1(text,uuid,uuid,bigint,bytea,bigint,bytea,bytea) TO ${app};
RESET ROLE;`;
 return change(sql,'RESET ROLE;',grant);
}
