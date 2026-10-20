import {entitySchema,runtimeViewSchema,entityTables,immutableEntityTables} from '../server/entity-schema.ts';
import {writeEntities,readEntities,validateTenantPayload} from '../server/entity-repository.ts';
import {canonical,digest} from '../server/imports.ts';
export async function initializeEntities(client,tenantId){
 const original=(await client.query('SELECT revision,payload FROM runtime_state WHERE singleton=true FOR UPDATE')).rows[0];if(!original)throw Error('Missing migration source');const payload=original.payload;validateTenantPayload(payload,tenantId);
 await client.query(entitySchema);
 const initial={business:Object.fromEntries(Object.keys(entityTables).map(k=>[k,[]])),imports:{batches:[],records:payload.imports.records,requests:[]},audits:payload.audits,idempotency:[]};
 await writeEntities(client,initial,payload,tenantId);
 await client.query('ALTER TABLE runtime_state RENAME TO migration_snapshot_v2');
 for(const table of immutableEntityTables)await client.query(`CREATE TRIGGER immutable_managed_data BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_managed_data_mutation()`);
 await client.query('INSERT INTO business_state(tenant_id,revision,schema_version,payload_digest) VALUES($1,$2,3,$3)',[tenantId,original.revision,digest(canonical(payload))]);
 await client.query(runtimeViewSchema);
 const rebuilt=await readEntities(client,tenantId);if(canonical(rebuilt.payload)!==canonical(payload)||rebuilt.revision!==Number(original.revision))throw Error('Normalized migration changed original business data');
 return {entities:Object.values(payload.business).reduce((n,a)=>n+a.length,0),batches:payload.imports.batches.length};
}
