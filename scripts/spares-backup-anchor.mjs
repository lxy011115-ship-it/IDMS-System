import {verifySparesDatabase} from '../server/spares-db.ts';

const fail=()=>{throw Error('Backup spares continuity anchor is invalid');};
const decimal=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function validateSparesBackupAnchor(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.available!=='boolean')fail();
 if(!value.available){if(Object.keys(value).length!==1)fail();return value;}
 const names=['available','revision','events','entities','receipts','firstSequence','lastSequence','firstPreviousHash','firstHash','lastHash'];
 if(Object.keys(value).length!==names.length||names.some(name=>!Object.hasOwn(value,name)))fail();
 if(['revision','events','entities','receipts','firstSequence','lastSequence'].some(name=>!decimal(value[name]))||value.events!==value.revision||value.lastSequence!==value.revision||value.firstPreviousHash!=='GENESIS')fail();
 if(value.events==='0'){if(value.firstSequence!=='0'||value.firstHash!=='GENESIS'||value.lastHash!=='GENESIS')fail();}
 else if(value.firstSequence!=='1'||!hex(value.firstHash)||!hex(value.lastHash))fail();
 return value;
}
/** Must run inside the caller's RR snapshot. Always invokes complete verification. */
export async function captureSparesBackupAnchor(client,tenantId){
 if(!(await client.query("SELECT to_regclass('idms_spares.state') AS relation")).rows[0]?.relation)return {available:false};
 await verifySparesDatabase(client,tenantId);
 const rows=(await client.query(`/* IDMS_SPARES_BACKUP_ANCHOR */ SELECT revision::text,
  (SELECT count(*)::text FROM idms_spares.events WHERE tenant_id=$1) AS events,
  (SELECT count(*)::text FROM idms_spares.entities WHERE tenant_id=$1) AS entities,
  (SELECT count(*)::text FROM idms_spares.receipts WHERE tenant_id=$1) AS receipts,
  (SELECT hash FROM idms_spares.events WHERE tenant_id=$1 ORDER BY sequence LIMIT 1) AS first_hash,
  (SELECT hash FROM idms_spares.events WHERE tenant_id=$1 ORDER BY sequence DESC LIMIT 1) AS last_hash
  FROM idms_spares.state WHERE tenant_id=$1`,[tenantId])).rows;
 if(rows.length!==1)fail();const row=rows[0],anchor={available:true,revision:row.revision,events:row.events,entities:row.entities,receipts:row.receipts,firstSequence:row.events==='0'?'0':'1',lastSequence:row.revision,firstPreviousHash:'GENESIS',firstHash:row.first_hash??'GENESIS',lastHash:row.last_hash??'GENESIS'};
 return validateSparesBackupAnchor(anchor);
}
