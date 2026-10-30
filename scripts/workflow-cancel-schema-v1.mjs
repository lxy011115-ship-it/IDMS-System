import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const resources=new URL('../services/workflow/src/main/resources/',import.meta.url);
const identifier=v=>{if(typeof v!=='string'||!/^idms_[a-z0-9_]{1,58}$/.test(v))throw Error('WORKFLOW_CANCEL_ROLE');return '"'+v+'"';};
export async function workflowCancelSchemaSqlV1({owner,reconciler,tenantId,authorityId}){
 if(owner===reconciler||typeof tenantId!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(tenantId)||typeof authorityId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(authorityId))throw Error('WORKFLOW_CANCEL_CONFIG');
 let sql=await readFile(new URL('workflow-cancel-reconcile-v1.sql',resources),'utf8');
 for(const [key,value]of Object.entries({OWNER:identifier(owner),RECONCILER:identifier(reconciler),TENANT:tenantId,AUTHORITY:authorityId}))sql=sql.replaceAll('__'+key+'__',value);
 if(/__[A-Z]+__/.test(sql))throw Error('WORKFLOW_CANCEL_TEMPLATE');return sql;
}
export async function workflowCancelCatalogV1(client){
 const sql=await readFile(new URL('workflow-cancel-catalog-v1.sql',resources),'utf8');
 const value=(await client.query(sql)).rows[0]?.manifest;
 if(typeof value!=='string'||Buffer.byteLength(value)>256000)throw Error('WORKFLOW_CANCEL_CATALOG');
 const manifest=JSON.parse(value);if(!manifest.schema||manifest.functions?.length!==4||manifest.relations?.length!==4)throw Error('WORKFLOW_CANCEL_CATALOG');
 return {databaseOid:manifest.databaseOid,roleOid:manifest.roleOid,catalogHash:createHash('sha256').update(value).digest('hex')};
}
