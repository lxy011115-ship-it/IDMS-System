import {createHash} from 'node:crypto';
import {databaseFacts} from './backup-support.mjs';
import {canonical} from '../server/imports.ts';
import {captureFieldFactSession,applyFieldFactSession} from './field-fact-session.mjs';
import {readFieldDatabaseContext} from './field-capture-context.mjs';
export const workflowArchiveError=code=>Object.assign(Error(code),{code});
export const workflowRequire=(ok,code)=>{if(!ok)throw workflowArchiveError(code);};
export const workflowSha=v=>createHash('sha256').update(canonical(v)).digest('hex');
export const workflowQuote=v=>'"'+v.replaceAll('"','""')+'"';
const tables=`act_evt_log act_ge_bytearray act_ge_property act_hi_actinst act_hi_attachment act_hi_comment act_hi_detail act_hi_entitylink act_hi_identitylink act_hi_procinst act_hi_taskinst act_hi_tsk_log act_hi_varinst act_procdef_info act_re_deployment act_re_model act_re_procdef act_ru_actinst act_ru_deadletter_job act_ru_entitylink act_ru_event_subscr act_ru_execution act_ru_external_job act_ru_history_job act_ru_identitylink act_ru_job act_ru_suspended_job act_ru_task act_ru_timer_job act_ru_variable flw_channel_definition flw_event_definition flw_event_deployment flw_event_resource flw_ru_batch flw_ru_batch_part idms_workflow_cases idms_workflow_commands`.split(' ');
export const workflowFactDefaults=Object.freeze({format:'idms-field-fact-session-v1',TimeZone:'UTC',DateStyle:'ISO, YMD',IntervalStyle:'postgres',extra_float_digits:'3',bytea_output:'hex',standard_conforming_strings:'on'});
export async function workflowFactSession(c){await applyFieldFactSession(c,workflowFactDefaults);await c.query('SET max_parallel_workers_per_gather=0');}
export async function workflowArchiveContext(c,database){return {format:'idms-workflow-capture-context-v1',database:await readFieldDatabaseContext(c,database),session:await captureFieldFactSession(c)};}
export async function workflowArchiveFacts(c){
 workflowRequire(c.getTransactionStatus?.()==='T','WF_ARCHIVE_TRANSACTION_REQUIRED');
 const s=(await c.query("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation")).rows[0];
 workflowRequire(s.readonly==='on'&&s.isolation==='repeatable read','WF_ARCHIVE_READONLY_REQUIRED');
 const names=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename COLLATE \"C\"")).rows.map(r=>r.tablename);
 workflowRequire(canonical(names)===canonical(tables),'WF_ARCHIVE_SCHEMA');
 const namespaces=(await c.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' ORDER BY nspname")).rows.map(r=>r.nspname);workflowRequire(canonical(namespaces)===canonical(['public']),'WF_ARCHIVE_SCHEMA');
 for(const name of names){const value=(await c.query('SELECT COALESCE(max(octet_length(to_jsonb(t)::text)),0) AS bytes FROM public.'+workflowQuote(name)+' t')).rows[0].bytes;workflowRequire(Number(value)<=64*1024**2,'WF_ARCHIVE_ROW_LIMIT');}
 const data=await databaseFacts(c);
 const indexes=(await c.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname COLLATE \"C\"")).rows;
 const constraints=(await c.query("SELECT c.relname AS table_name,co.conname,pg_get_constraintdef(co.oid,true) AS definition FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname COLLATE \"C\",co.conname COLLATE \"C\"")).rows;
 const views=(await c.query("SELECT viewname,definition FROM pg_views WHERE schemaname='public' ORDER BY viewname COLLATE \"C\"")).rows;
 const routines=(await c.query("SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname COLLATE \"C\",pg_get_function_identity_arguments(p.oid) COLLATE \"C\"")).rows;
 const triggers=(await c.query("SELECT c.relname AS table_name,t.tgname,pg_get_triggerdef(t.oid,true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname COLLATE \"C\",t.tgname COLLATE \"C\"")).rows;
 const definitions=(await c.query("SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename COLLATE \"C\"")).rows;
 workflowRequire(canonical(definitions.map(r=>r.sequencename))===canonical(['act_evt_log_log_nr__seq','act_hi_tsk_log_id__seq']),'WF_ARCHIVE_SEQUENCE_SCHEMA');
 const sequences=[];for(const d of definitions)sequences.push({...d,...(await c.query('SELECT last_value::text,is_called FROM public.'+workflowQuote(d.sequencename))).rows[0]});
 return {format:'idms-workflow-archive-facts-v2',tables:data,indexes,constraints,views,routines,triggers,sequences};
}
