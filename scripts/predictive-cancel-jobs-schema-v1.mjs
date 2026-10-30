import {readFile} from 'node:fs/promises';
export async function predictiveCancelJobsSchemaSqlV1({tenant,owner,worker,ingress,deployment}){
 const ident=v=>{if(typeof v!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(v))throw Error('RECON_QUEUE_INSTALL_ROLE');return '"'+v+'"';},literal=v=>"'"+v.replaceAll("'","''")+"'";
 if(typeof tenant!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(tenant)||!/^[a-f0-9]{64}$/.test(deployment)||new Set([owner,worker,ingress]).size!==3)throw Error('RECON_QUEUE_INSTALL_CONFIG');
 let sql=await readFile(new URL('./predictive-cancel-jobs-v1.sql',import.meta.url),'utf8');
 for(const [key,value]of Object.entries({OWNER:ident(owner),WORKER:ident(worker),INGRESS:ident(ingress),OWNER_LITERAL:literal(owner),WORKER_LITERAL:literal(worker),INGRESS_LITERAL:literal(ingress),TENANT:literal(tenant),DEPLOYMENT:literal(deployment)}))sql=sql.replaceAll('__'+key+'__',value);
 if(/__[A-Z_]+__/.test(sql))throw Error('RECON_QUEUE_INSTALL_TEMPLATE');return sql;
}
