import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {resolve,join} from 'node:path';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
import {createOwnedPlatformPgQaV1} from './fixtures/owned-platform-pg-v1-qa.mjs';
import {createColdReviewCommitProxyQaV2} from './fixtures/cold-review-commit-proxy-v2-qa.mjs';
import {createColdReviewCommitProxyQaV3} from './fixtures/cold-review-commit-proxy-v3-qa.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {coldToolingV1,coldStoppedV1} from './pg-cold-image-portable-tools-v1.mjs';
import {canonical} from '../server/imports.ts';
const bin=resolve(process.argv[2]),nonce=randomBytes(6).toString('hex'),work=resolve('work/pg-proxy-latency-native-v1-20261025',nonce),sha=b=>createHash('sha256').update(b).digest('hex');await privateDirectory(work);
const files=['scripts/fixtures/owned-platform-pg-v1-qa.mjs','scripts/fixtures/cold-review-commit-proxy-v2-qa.mjs','scripts/fixtures/cold-review-commit-proxy-v3-qa.mjs','scripts/verify-pg-proxy-latency-v1.mjs'],sourcePins=[];
for(const path of files)sourcePins.push({path,sha256:sha(await readFile(path))});
let cluster,slow,fast,problem;const clients=new Set(),report={format:'ACTUAL_PG_PROXY_LATENCY_QA_V1',nonce,passed:false,sourcePins,checks:[],samples:[],cleanupErrors:[]},note=name=>{report.checks.push(name);console.log(JSON.stringify({nonce,check:report.checks.length,name}));};
console.log(JSON.stringify({nativeStarted:true,nonce,pid:process.pid,sourcePins:sourcePins.length,expectedChecks:4}));
const connect=async port=>{const c=new pg.Client({...cluster.account,database:'postgres',port:port??cluster.account.port,connectionTimeoutMillis:5000});clients.add(c);c.on('error',()=>{});await c.connect();return c;},end=async c=>{if(c){await c.end();clients.delete(c);}};
try{
 cluster=await createOwnedPlatformPgQaV1(bin);slow=await createColdReviewCommitProxyQaV2(cluster.account.port);fast=await createColdReviewCommitProxyQaV3(cluster.account.port);
 const sample=async(kind,port)=>{const c=await connect(port);try{assert.equal((await c.query('SELECT 1::int AS value')).rows[0].value,1);const started=performance.now();for(let i=0;i<80;i++)assert.equal((await c.query('SELECT 1::int AS value')).rows[0].value,1);report.samples.push({kind,queries:80,elapsedMs:performance.now()-started});}finally{await end(c);}};
 await sample('DIRECT',cluster.account.port);for(let round=0;round<3;round++){await sample('OLD_PROXY',slow.port);await sample('NO_DELAY_PROXY',fast.port);await sample('NO_DELAY_PROXY',fast.port);await sample('OLD_PROXY',slow.port);}
 note('actual PostgreSQL returns every expected row through direct and both owned loopback proxies in three ABBA rounds');
 const root=await connect();try{await root.query('CREATE TABLE public.proxy_commit_qa(id int PRIMARY KEY,value text NOT NULL)');}finally{await end(root);}
 for(const [proxy,label,id]of[[slow,'OLD_PROXY',1],[fast,'NO_DELAY_PROXY',3]]){
  let c=await connect(proxy.port);try{await c.query('BEGIN');await c.query('INSERT INTO public.proxy_commit_qa VALUES($1,$2)',[id,label]);proxy.arm('BEFORE_COMMIT');await assert.rejects(c.query('COMMIT'));}finally{await end(c);}c=await connect();try{assert.equal((await c.query('SELECT count(*)::int AS n FROM public.proxy_commit_qa WHERE id=$1',[id])).rows[0].n,0);}finally{await end(c);}
  c=await connect(proxy.port);try{await c.query('BEGIN');await c.query('INSERT INTO public.proxy_commit_qa VALUES($1,$2)',[id+1,label]);proxy.arm('AFTER_COMMIT');await assert.rejects(c.query('COMMIT'));}finally{await end(c);}c=await connect();try{assert.equal((await c.query('SELECT count(*)::int AS n FROM public.proxy_commit_qa WHERE id=$1 AND value=$2',[id+1,label])).rows[0].n,1);}finally{await end(c);}
  assert.equal(proxy.events.filter(e=>e.type==='COMMIT_NOT_FORWARDED').length,1);assert.equal(proxy.events.filter(e=>e.type==='ACTUAL_COMMIT_REPLY_WITHHELD').length,1);
 }
 note('both proxies preserve actual not-committed and committed-but-reply-withheld semantics verified by fresh direct SQL');
 await slow.close();await fast.close();assert.equal(slow.state().activeConnections,0);assert.equal(fast.state().activeConnections,0);assert.equal(fast.state().tcpNoDelayEnabled,true);
 note('only original test transport sockets retire normally without adopting any target connection');
 await cluster.stop();const tooling=await coldToolingV1(bin);await coldStoppedV1(cluster.source,tooling,cluster.systemIdentifier);report.actualPgCleanOffline=true;report.medians={};for(const kind of['DIRECT','OLD_PROXY','NO_DELAY_PROXY']){const values=report.samples.filter(s=>s.kind===kind).map(s=>s.elapsedMs).sort((a,b)=>a-b);report.medians[kind]=values[Math.floor(values.length/2)];}
 note('original owned PostgreSQL stops and its actual control data confirms clean offline state');report.passed=true;
}catch(e){problem=e;report.failureCode=/^[A-Z_0-9]{4,128}$/.test(e.message)?e.message:'PROXY_LATENCY_QA_FAILED';report.failureMessageSha256=sha(String(e.message));}
finally{
 for(const c of clients)try{await end(c);}catch(e){report.cleanupErrors.push('CLIENT_END_UNPROVEN');}for(const p of[slow,fast])try{if(p&&!p.state().closing)await p.close();}catch{report.cleanupErrors.push('PROXY_END_UNPROVEN');}if(cluster)try{await cluster.stop();}catch{report.cleanupErrors.push('PG_STOP_UNPROVEN');}
 for(const pin of sourcePins)assert.equal(sha(await readFile(pin.path)),pin.sha256);if(report.cleanupErrors.length)report.passed=false;await privateNewFile(join(work,'verification.json'),canonical(report));console.log(JSON.stringify({nonce,work,passed:report.passed,checks:report.checks.length,cleanupErrorCount:report.cleanupErrors.length,medians:report.medians??null,failureCode:report.failureCode??null}));if(!report.passed)process.exitCode=1;
}
