import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Fresh owned PostgreSQL 16.10 + bundled Keycloak 26.8.1, independently checked before/after ordinary startup.
export const reviewedIdentityContract=Object.freeze({schema:'0b40037480923b11b33e2850bb344e5f52268871cc95bb21001511c3d555af7b',changes:'afee16d2e1f30d84c9606ea4f3a2576969c101b9c44aaa6e5ad2352d5bb00ca9',changeCount:237});
/** Catalog and change-set content only; never users, credentials, timestamps or sessions. */
export async function existingIdentityContract(client){
 const columns=(await client.query("SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS def FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname,a.attnum")).rows;
 const constraints=(await client.query("SELECT c.relname,x.conname,pg_get_constraintdef(x.oid) AS definition FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,x.conname")).rows;
 const indexes=(await client.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows;
 const changes=(await client.query('SELECT id,author,filename,md5sum FROM public.databasechangelog ORDER BY id,author,filename')).rows;
 return {schema:digest({columns,constraints,indexes}),changes:digest(changes),changeCount:changes.length};
}
