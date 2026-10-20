import {readFile} from 'node:fs/promises';
const ident=v=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(v))throw Error('AI_REVIEW_INSTALL_ROLE');return '"'+v+'"';};
export async function aiReviewTransportSchemaV4({owner,app,tenant,deployment,keyCheck}){
 if(owner===app||!/^[A-Za-z0-9_-]{1,80}$/.test(tenant)||!/^[a-f0-9]{64}$/.test(deployment)||!keyCheck||Buffer.byteLength(JSON.stringify(keyCheck))>1000)throw Error('AI_REVIEW_INSTALL_BINDING');
 let sql=await readFile(new URL('./ai-review-transport-v4.sql',import.meta.url),'utf8');for(const [k,v]of Object.entries({OWNER:ident(owner),APP:ident(app),OWNER_LITERAL:"'"+owner+"'",APP_LITERAL:"'"+app+"'",TENANT:"'"+tenant+"'",DEPLOYMENT:"'"+deployment+"'",KEY_CHECK:"'"+JSON.stringify(keyCheck).replaceAll("'","''")+"'::jsonb"}))sql=sql.replaceAll('__'+k+'__',v);if(/__[A-Z_]+__/.test(sql))throw Error('AI_REVIEW_INSTALL_TEMPLATE');return sql;
}
