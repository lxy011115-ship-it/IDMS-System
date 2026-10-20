import {readFile,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import pg from 'pg';
import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import type {PublicGovernedSource} from './source-governance.ts';
import {publicGovernedSource} from './source-governance.ts';
import {AiReviewCryptoV4,type AiReviewBindingV4} from './ai-review-crypto-v4.ts';
import {AiImportSourceV4} from './ai-import-source-v4.ts';
import {aiReviewGatewayV4,aiReviewNeedV4 as need,type AiReviewGatewayV4} from './ai-review-request-v4.ts';
import {DomainMapSnapshot} from './domain-map-v4.ts';
import {canonicalEqual} from './canonical-state.ts';
import {aiImportPolicyKeyV4,aiImportPolicyV4} from './ai-import-contract-v4.ts';
interface AiImportRuntimeFileV4 {format:1;mode:'AI_WORKER';source:{account:ClientConfig;binding:AiReviewBindingV4;stateBinding:StateMapBinding;keyFile:string;gateway:AiReviewGatewayV4};sources:PublicGovernedSource[]}
export async function aiImportPrivateJsonV4(file:string){const s=await lstat(file);need(s.isFile()&&!s.isSymbolicLink()&&s.size<=2*1024*1024,'AI_IMPORT_PRIVATE_FILE');try{return JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));}catch{throw Error('AI_IMPORT_PRIVATE_JSON');}}
/** No setup, schema repair, fallback credentials or authentication master keys. */
export async function loadAiImportRuntimeV4(file:string){
 const path=resolve(file),config=await aiImportPrivateJsonV4(path) as AiImportRuntimeFileV4;need(config?.format===1&&config.mode==='AI_WORKER'&&config.source&&Array.isArray(config.sources)&&config.sources.length>0,'AI_IMPORT_RUNTIME_FORMAT');const input=config.source;aiReviewGatewayV4(input.gateway);const material=await aiImportPrivateJsonV4(resolve(dirname(path),input.keyFile));need(material?.format===1&&material.purpose==='AI_IMPORT_TRANSPORT_V4_1'&&typeof material.key==='string'&&/^[A-Za-z0-9_-]{43}$/.test(material.key),'AI_IMPORT_KEY_PURPOSE');const key=Buffer.from(material.key,'base64url');need(key.length===32&&key.toString('base64url')===material.key,'AI_IMPORT_KEY_ENCODING');const crypto=new AiReviewCryptoV4(key,input.binding,input.gateway),source=new AiImportSourceV4(input.account,input.binding,crypto,input.stateBinding),sources=config.sources.map(publicGovernedSource);need(sources.every(s=>s.tenantId===input.binding.tenantId),'AI_IMPORT_RUNTIME_TENANT');
 const c=new pg.Client({...input.account,connectionTimeoutMillis:3000,query_timeout:15000});c.on('error',()=>{});try{await c.connect();await c.query('BEGIN READ ONLY');await source.verify(c);const flags=(await c.query("SELECT has_function_privilege(session_user,'ai_review_v4.enqueue_v4(jsonb,text,jsonb)','EXECUTE') AS old_enqueue,has_function_privilege(session_user,'ai_review_v4.result_v4(uuid,uuid,uuid,bigint,jsonb,text)','EXECUTE') AS old_result,has_function_privilege(session_user,'governance_jobs_v4.prepare_console_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,uuid,bigint,bytea,jsonb)','EXECUTE') AS old_prepare,has_function_privilege(session_user,'ai_review_v4.record_import_result_v4(uuid,uuid,uuid,bigint,jsonb,text)','EXECUTE') AS result,has_function_privilege(session_user,'ai_review_v4.publish_application_v4(text,uuid,uuid,uuid,bigint,uuid,uuid,bigint,bytea,bigint,bytea,bytea)','EXECUTE') AS apply")).rows[0];need(!flags.old_enqueue&&!flags.old_result&&!flags.old_prepare&&flags.result&&flags.apply,'AI_IMPORT_RUNTIME_PROTOCOL');await c.query('COMMIT');}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{await c.end();}
 const snapshot=await DomainMapSnapshot.open(input.account,input.stateBinding,{maintenance:true});try{need(canonicalEqual(await snapshot.get('domain_head',aiImportPolicyKeyV4),aiImportPolicyV4(source.configuration)),'AI_IMPORT_RUNTIME_POLICY');}finally{await snapshot.close();}return {config,source,sources};
}
