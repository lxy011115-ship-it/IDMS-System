import {canonical} from '../server/imports.ts';
import {fieldFactSession,captureFieldFactSession} from './field-fact-session.mjs';
const fail=()=>{throw Object.assign(Error('FIELD_CAPTURE_CONTEXT_INVALID'),{code:'FIELD_CAPTURE_CONTEXT_INVALID'});};
const object=(v,keys)=>{if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail();return v;};
const text=(v,max)=>{if(typeof v!=='string'||!v.length||v.length>max||v.includes('\0'))fail();};
export function fieldDatabaseContext(raw){
 const r=object(raw,['encoding','provider','collate','ctype','icuLocale','icuRules','collationVersion','actualCollationVersion']);
 if(typeof r.encoding!=='string'||!/^[A-Z0-9_]{1,32}$/.test(r.encoding)||!['c','i'].includes(r.provider))fail();text(r.collate,1024);text(r.ctype,1024);
 for(const k of ['icuLocale','icuRules','collationVersion','actualCollationVersion'])if(r[k]!==null)text(r[k],k==='icuRules'?16384:1024);
 if(r.provider==='c'&&(r.icuLocale!==null||r.icuRules!==null)||r.provider==='i'&&r.icuLocale===null||r.collationVersion!==r.actualCollationVersion)fail();
 return Object.freeze(JSON.parse(canonical(r)));
}
export function fieldCaptureContext(raw){const r=object(raw,['format','database','session']);if(r.format!=='idms-field-capture-context-v1')fail();return Object.freeze({format:r.format,database:fieldDatabaseContext(r.database),session:fieldFactSession(r.session)});}
export async function readFieldDatabaseContext(client,database){
 const rows=(await client.query('SELECT pg_encoding_to_char(encoding) AS encoding,datlocprovider::text AS provider,datcollate AS collate,datctype AS ctype,daticulocale AS "icuLocale",daticurules AS "icuRules",datcollversion AS "collationVersion",pg_database_collation_actual_version(oid) AS "actualCollationVersion" FROM pg_database WHERE datname=$1',[database])).rows;
 if(rows.length!==1)fail();return fieldDatabaseContext(rows[0]);
}
export async function captureFieldContext(client,database){return fieldCaptureContext({format:'idms-field-capture-context-v1',database:await readFieldDatabaseContext(client,database),session:await captureFieldFactSession(client)});}
export function fieldDatabaseCreateOptions(raw){const r=fieldDatabaseContext(raw),literal=s=>"E'"+s.replaceAll("\\","\\\\").replaceAll("'","''")+"'";return 'ENCODING '+literal(r.encoding)+' LC_COLLATE '+literal(r.collate)+' LC_CTYPE '+literal(r.ctype)+' LOCALE_PROVIDER '+(r.provider==='c'?'libc':'icu')+(r.provider==='i'?' ICU_LOCALE '+literal(r.icuLocale)+(r.icuRules!==null?' ICU_RULES '+literal(r.icuRules):''):'');}
