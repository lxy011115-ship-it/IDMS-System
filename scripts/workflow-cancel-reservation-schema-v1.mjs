import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const resources=new URL('../services/workflow/src/main/resources/',import.meta.url),sha=s=>createHash('sha256').update(s).digest('hex');
export async function workflowCancelReservationSchemaSqlV1({owner,reconciler,tenantId,authorityId}){
 if(![owner,reconciler].every(v=>typeof v==='string'&&/^idms_[a-z0-9_]{1,58}$/.test(v))||owner===reconciler||!/^[a-z][a-z0-9_-]{0,63}$/.test(tenantId)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(authorityId))throw Error('WORKFLOW_RESERVATION_CONFIG');
 let sql=await readFile(new URL('workflow-cancel-reservation-v1.sql',resources),'utf8');for(const [key,value]of Object.entries({OWNER:'"'+owner+'"',RECONCILER:'"'+reconciler+'"',TENANT:tenantId,AUTHORITY:authorityId}))sql=sql.replaceAll('__'+key+'__',value);return sql;
}
export async function workflowCancelReservationCatalogV1(client){
 const base=await readFile(new URL('workflow-cancel-catalog-v1.sql',resources),'utf8'),extension=await readFile(new URL('workflow-cancel-reservation-catalog-v1.sql',resources),'utf8'),sql=extension.replace('__BASE_CATALOG__',base.trim());
 const manifest=(await client.query(sql)).rows[0]?.manifest;if(typeof manifest!=='string'||Buffer.byteLength(manifest)>512000)throw Error('WORKFLOW_RESERVATION_CATALOG');
 const value=JSON.parse(manifest),old=JSON.parse(value.baseManifest);if(!value.schema||value.relations?.length!==1||value.functions?.length!==6||old.functions?.length!==4||old.relations?.length!==4)throw Error('WORKFLOW_RESERVATION_CATALOG');
 return {databaseOid:old.databaseOid,roleOid:old.roleOid,catalogHash:sha(manifest),baseCatalogHash:sha(value.baseManifest)};
}
