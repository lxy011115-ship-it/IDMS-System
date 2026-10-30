// QA-only independent native owner: detached models an actual surviving orphan.
// Production runWorkflowDump keeps its normal attached process behavior.
import {readFile,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {canonical} from '../../server/imports.ts';
import {privateNewFile} from '../backup-support.mjs';
import {workflowArchiveOwner} from '../workflow-archive-native.mjs';
const s=JSON.parse(await readFile(process.argv[2],'utf8')),tool={...s.tool,owner:await workflowArchiveOwner()};
await privateNewFile(s.toolFile,canonical(tool));const f=await open(tool.dumpFile,'wx',0o600);await f.close();
const env={...process.env};for(const k of Object.keys(env))if(/^PG/i.test(k))delete env[k];
Object.assign(env,{PGHOST:s.authority.host,PGPORT:String(s.authority.port),PGUSER:'idms_bootstrap',PGPASSWORD:s.authority.bootstrapPassword,PGDATABASE:s.database,PGAPPNAME:tool.applicationName,PGCONNECT_TIMEOUT:'5',PGOPTIONS:'-c default_transaction_read_only=on -c max_parallel_workers_per_gather=0'});
const child=spawn(tool.program,tool.args,{env,detached:true,windowsHide:true,stdio:'ignore'});child.on('error',e=>process.send?.({type:'ERROR',message:e.code}));
child.once('spawn',()=>process.send?.({type:'BARRIER',phase:'NATIVE_STARTED',value:{pid:child.pid}}));
process.on('message',()=>{});
