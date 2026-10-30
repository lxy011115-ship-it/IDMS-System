// QA-only: two detached native children model independently surviving orphans.
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {canonical} from '../../server/imports.ts';
import {privateNewFile} from '../backup-support.mjs';
import {workflowArchiveOwner} from '../workflow-archive-native.mjs';
const s=JSON.parse(await readFile(process.argv[2],'utf8')),owner=await workflowArchiveOwner(),children=[];
for(const spec of s.tools){const tool={...spec.tool,owner};await privateNewFile(spec.file,canonical(tool));const env={...process.env};for(const k of Object.keys(env))if(/^PG/i.test(k))delete env[k];Object.assign(env,{PGHOST:s.authority.host,PGPORT:String(s.authority.port),PGUSER:'idms_bootstrap',PGPASSWORD:s.authority.bootstrapPassword,PGDATABASE:tool.targetDatabase,PGAPPNAME:tool.applicationName,PGCONNECT_TIMEOUT:'5',PGOPTIONS:'-c timezone=UTC -c max_parallel_workers_per_gather=0'});const child=spawn(tool.program,tool.args,{env,detached:true,windowsHide:true,stdio:'ignore'});await new Promise((ok,reject)=>{child.once('spawn',ok);child.once('error',reject);});children.push({pid:child.pid,runId:tool.runId});}
process.send?.({type:'READY',owner,children});process.on('message',()=>{});
