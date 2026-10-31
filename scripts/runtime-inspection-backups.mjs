import {opendir,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {openBackup} from './backup-support.mjs';
import {InspectionError,need,checkedPath,boundedFile,privateJson} from './runtime-inspection-input.mjs';
import {checkSignal} from './runtime-inspection-probes.mjs';

/** Authentication only: no restore/provision/database calls or plaintext files. */
export async function inspectBackups(root,profile,business,{verify=false,signal,deadline=Infinity}={}){
 const tenants=Object.keys(business.tenants),files=new Map(tenants.map(t=>[t,[]])),seen=new Set();let entries=0,folders=0;
 async function scan(path,depth){
  checkSignal(signal,deadline);try{path=await checkedPath(path);}catch(e){if(e.code==='ENOENT')throw new InspectionError('BACKUP_DIRECTORY_MISSING','NOT_CONFIGURED');throw e;}
  need((await lstat(path)).isDirectory(),'BACKUP_DIRECTORY_INVALID');if(seen.has(path))return;seen.add(path);if(++folders>64)throw new InspectionError('ARCHIVE_SCAN_LIMIT','UNKNOWN');
  for await(const entry of await opendir(path)){
   checkSignal(signal,deadline);if(++entries>tenants.length*32+128)throw new InspectionError('ARCHIVE_SCAN_INCOMPLETE','UNKNOWN');
   const p=join(path,entry.name),s=await lstat(p);need(!s.isSymbolicLink(),'LINKED_INPUT_REFUSED');
   if(s.isDirectory()){if(depth>=2)throw new InspectionError('ARCHIVE_SCAN_INCOMPLETE','UNKNOWN');await scan(p,depth+1);continue;}
   if(!entry.name.endsWith('.idmsbackup'))continue;need(s.isFile()&&s.nlink===1,'INPUT_SIZE_OR_TYPE');
   const tenant=tenants.find(t=>entry.name.startsWith(t+'-'));need(tenant,'ARCHIVE_TENANT_UNBOUND');
   const list=files.get(tenant);list.push(p);if(list.length>32)throw new InspectionError('ARCHIVE_SCAN_INCOMPLETE','UNKNOWN');
  }
 }
 for(const path of profile.directories)await scan(resolve(root,path),0);
 const count=[...files.values()].reduce((n,f)=>n+f.length,0),data={archiveCount:count,tenantCount:tenants.length,authenticatedCount:0,restorePerformed:false,agePolicyConfigured:profile.maxAgeHours!==null};
 if(!count)return {status:'NOT_CONFIGURED',code:'BACKUP_FILES_MISSING',evidence:'FILE_METADATA',data};
 if([...files.values()].some(f=>!f.length))return {status:'FAIL',code:'BACKUP_COVERAGE_MISSING',evidence:'FILE_METADATA',data};
 if(!verify)return {status:'UNKNOWN',code:'ARCHIVES_NOT_AUTHENTICATED',evidence:'FILE_METADATA',data};
 const {value:k}=await privateJson(resolve(root,profile.keyFile),1024);need(k.format===1&&typeof k.keyId==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(k.keyId)&&typeof k.key==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(k.key),'BACKUP_KEY_INVALID');
 const key={keyId:k.keyId,bytes:Buffer.from(k.key,'base64')};k.key='';need(key.bytes.length===32,'BACKUP_KEY_INVALID');const latest=[];
 try{
  for(const [tenant,paths] of files){let mostRecent=-Infinity;
   for(const path of paths){
    checkSignal(signal,deadline);const archive=await boundedFile(path,128*1024*1024+256*1024+56);let opened;
    try{opened=openBackup(archive,key,tenant);const m=opened.manifest;need(m.format===2,'ARCHIVE_FORMAT2_REQUIRED');need(m.sourceDatabase===business.tenants[tenant].database,'ARCHIVE_SOURCE_MISMATCH');const created=Date.parse(m.createdAt);need(Number.isFinite(created)&&created<=Date.now()+300000,'ARCHIVE_TIMESTAMP_INVALID');mostRecent=Math.max(mostRecent,created);data.authenticatedCount++;}
    catch(e){if(e instanceof InspectionError)throw e;throw new InspectionError('ARCHIVE_AUTHENTICATION_FAILED');}
    finally{opened?.dump.fill(0);}
    checkSignal(signal,deadline);
   }
   latest.push(mostRecent);
  }
 }finally{key.bytes.fill(0);}
 data.oldestLatestCreatedAt=new Date(Math.min(...latest)).toISOString();
 if(profile.maxAgeHours===null)return {status:'UNKNOWN',code:'BACKUP_AGE_POLICY_UNSET',evidence:'ARCHIVE_AUTHENTICATED_NOT_RESTORED',data};
 if(latest.some(at=>Date.now()-at>profile.maxAgeHours*3600000))return {status:'FAIL',code:'BACKUP_STALE',evidence:'ARCHIVE_AUTHENTICATED_NOT_RESTORED',data};
 return {status:'PASS',code:'ARCHIVES_AUTHENTICATED',evidence:'ARCHIVE_AUTHENTICATED_NOT_RESTORED',data};
}
