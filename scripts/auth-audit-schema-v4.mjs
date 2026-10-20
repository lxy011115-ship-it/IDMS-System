import {readFile} from 'node:fs/promises';
const ident=v=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(v))throw Error('AUTH_AUDIT_INSTALL_ROLE');return '"'+v+'"';};
export async function authAuditSchemaSqlV4({owner,app,delivery,deployment,keyCheck}){
 if(new Set([owner,app,delivery]).size!==3||!/^[a-f0-9]{64}$/.test(deployment)||!keyCheck||Buffer.byteLength(JSON.stringify(keyCheck))>100000)throw Error('AUTH_AUDIT_INSTALL_BINDING');let sql=await readFile(new URL('./auth-audit-v4.sql',import.meta.url),'utf8');for(const [key,value]of Object.entries({OWNER:ident(owner),APP:ident(app),DELIVERY:ident(delivery),OWNER_LITERAL:"'"+owner+"'",APP_LITERAL:"'"+app+"'",DELIVERY_LITERAL:"'"+delivery+"'",DEPLOYMENT:"'"+deployment+"'",KEY_CHECK:"'"+JSON.stringify(keyCheck).replaceAll("'","''")+"'::jsonb"}))sql=sql.replaceAll('__'+key+'__',value);if(/__[A-Z_]+__/.test(sql))throw Error('AUTH_AUDIT_INSTALL_TEMPLATE');return sql;
}
