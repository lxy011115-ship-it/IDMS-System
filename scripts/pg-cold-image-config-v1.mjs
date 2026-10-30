import {coldNeedV1 as need} from './pg-cold-image-manifest-v1.mjs';
// Deliberately restricted offline profile. No includes, paths, executable hooks,
// preloaded libraries, SSL keys or external configuration can pass this profile.
const settings=new Set(['port','listen_addresses','max_connections','shared_buffers','dynamic_shared_memory_type','max_wal_size','min_wal_size','log_timezone','datestyle','timezone','lc_messages','lc_monetary','lc_numeric','lc_time','default_text_search_config','password_encryption','wal_level','fsync','full_page_writes','synchronous_commit']);
export function coldConfigV1(name,bytes){
 need(bytes.length<=1024**2,'COLD_IMAGE_CONFIG_LIMIT');const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);need(!raw.includes('\0'),'COLD_IMAGE_CONFIG');
 if(name==='PG_VERSION'){need(raw.trim()==='16','COLD_IMAGE_PG_VERSION');return;}
 for(const line of raw.split(/\r?\n/)){const s=line.trim();if(!s||s.startsWith('#'))continue;
  if(name==='pg_ident.conf'){need(false,'COLD_IMAGE_CONFIG');}
  if(name==='pg_hba.conf'){const t=s.split('#')[0].trim().split(/\s+/);need(t[0]==='local'&&t.length===4&&t[3]==='scram-sha-256'||t[0]==='host'&&t.length===5&&['127.0.0.1/32','::1/128'].includes(t[3])&&t[4]==='scram-sha-256','COLD_IMAGE_CONFIG');need(t[1]==='all'||t[1]==='replication','COLD_IMAGE_CONFIG');need(t[2]==='all','COLD_IMAGE_CONFIG');continue;}
  need(['postgresql.conf','postgresql.auto.conf'].includes(name),'COLD_IMAGE_CONFIG');
  const m=/^([a-z_]+)\s*=\s*('[A-Za-z0-9_., +:-]*'|[A-Za-z0-9_.+-]+)\s*(?:#.*)?$/.exec(s);need(m&&settings.has(m[1]),'COLD_IMAGE_CONFIG');const v=m[2].replace(/^'|'$/g,'');
  if(m[1]==='listen_addresses')need(['127.0.0.1','localhost'].includes(v),'COLD_IMAGE_CONFIG');
  if(['fsync','full_page_writes','synchronous_commit'].includes(m[1]))need(['on','true','1'].includes(v),'COLD_IMAGE_CONFIG');
  if(m[1]==='password_encryption')need(v==='scram-sha-256','COLD_IMAGE_CONFIG');
 }
}
export const coldConfigNamesV1=new Set(['PG_VERSION','postgresql.conf','postgresql.auto.conf','pg_hba.conf','pg_ident.conf']);
