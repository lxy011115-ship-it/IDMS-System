import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,readdir,rm,realpath,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {createColdBrowserPageCollectorV2,validateColdBrowserPageCaptureV2,verifyColdBrowserPageSnapshotBindingV2,verifyColdBrowserCookieSealV2} from './cold-browser-page-capture-v2-qa.mjs';
import {verifyColdBrowserStorageSnapshotV1} from './cold-browser-storage-v1-qa.mjs';

const owner='00000000-0000-4000-8000-000000000001',actor='00000000-0000-4000-8000-000000000002',nonce='123456789abc',hash='a'.repeat(64);
const sha=value=>createHash('sha256').update(value).digest('hex');
function sample(origin,stage='active'){return {format:'IDMS_COLD_BROWSER_PAGE_CAPTURE_V2',owner,nonce,origin,stage,capturedAt:Date.now(),local:[],session:[],indexedDbNames:[],cacheNames:[],recoveryView:stage==='logout'?null:{page:'/maintenance/',visibleReferenceIds:[]}};}
function snapshot(value,cookies=[]){const {stage,format,...rest}=value;return {format:'IDMS_COLD_BROWSER_STORAGE_SNAPSHOT_V1',...rest,cookies};}
async function fixture(run){
 const directory=await mkdtemp(join(tmpdir(),'idms-page-capture-v2-'));let collector,origin;
 const server=createServer(async(req,res)=>{if(await collector.handle(req,res))return;if(req.url==='/maintenance/'){collector.injectMaintenance(res);const body=Buffer.from('<html><body>维修测试页</body></html>');res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-length':body.length,'content-security-policy':"default-src 'self'; script-src 'self'"});res.end(body);return;}res.writeHead(404);res.end();});
 await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});origin='http://127.0.0.1:'+server.address().port;
 const startedAt=Date.now()-1000;collector=createColdBrowserPageCollectorV2({owner,nonce,origin,work:directory,startedAt,cookieHash:value=>value==='idms_session=public-unit-only'?hash:null});
 const post=(body,headers={})=>fetch(origin+'/__qa/browser-storage-v2/capture',{method:'POST',headers:{origin,referer:origin+'/maintenance/','content-type':'application/json','x-qa-owner':owner,'x-qa-nonce':nonce,...headers},body:typeof body==='string'?body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
 try{await run({directory,origin,startedAt,post,collector});}
 finally{server.closeIdleConnections();await new Promise(ok=>server.close(ok));const absolute=await realpath(directory),base=await realpath(tmpdir());assert(absolute.startsWith(base+sep)&&absolute.slice(base.length+1).startsWith('idms-page-capture-v2-')&&!(await lstat(directory)).isSymbolicLink());await rm(absolute,{recursive:true});}
}

test('three actual HTTP captures persist exact private bodies and bind the observed session hash',()=>fixture(async({origin,directory,post,startedAt})=>{
 for(const [offset,stage]of ['active','switched','logout'].entries()){
  const value=sample(origin,stage),response=await post(value,stage==='logout'?{}:{cookie:'idms_session=public-unit-only'});assert.equal(response.status,201);const publicResult=await response.json();assert.equal(publicResult.index,offset+1);assert.equal(publicResult.rawValuesDisplayed,false);assert(!Object.hasOwn(publicResult,'snapshot'));
  const envelope=JSON.parse(await readFile(join(directory,publicResult.file),'utf8'));assert.deepEqual(envelope.snapshot,value);const final=snapshot(value);assert(verifyColdBrowserPageSnapshotBindingV2(envelope,final,{owner,nonce,origin,stage,index:offset+1,expectedSessionHash:stage==='logout'?null:hash,startedAt}).requestSessionBound);
 }
 assert.equal((await readdir(directory)).length,3);
}));
test('wrong origin, owner, nonce, referring page and media type never create a capture',()=>fixture(async({origin,directory,post})=>{
 for(const headers of [{origin:'http://127.0.0.1:1'},{'x-qa-owner':actor},{'x-qa-nonce':'abcdef123456'},{referer:origin+'/predictive/'},{'content-type':'text/plain'}])assert.equal((await post(sample(origin),headers)).status,400);
 assert.deepEqual(await readdir(directory),[]);
}));
test('phase replay and out-of-order captures cannot consume another stage or overwrite a file',()=>fixture(async({origin,directory,post})=>{
 assert.equal((await post(sample(origin,'switched'))).status,400);assert.equal((await post(sample(origin))).status,201);const original=await readFile(join(directory,'browser-page-storage-0001.private.json'));
 assert.equal((await post(sample(origin))).status,400);assert.deepEqual(await readFile(join(directory,'browser-page-storage-0001.private.json')),original);
 assert.equal((await post(sample(origin,'logout'))).status,400);assert.equal((await post(sample(origin,'switched'))).status,201);assert.equal((await post(sample(origin,'logout'))).status,201);assert.equal((await post(sample(origin,'logout'))).status,400);assert.equal((await readdir(directory)).length,3);
}));
test('duplicate JSON properties, unknown fields and oversized uploads fail before saving',()=>fixture(async({origin,directory,post})=>{
 const duplicate=JSON.stringify(sample(origin)).replace('"stage":"active"','"stage":"logout","stage":"active"');
 for(const value of [duplicate,{...sample(origin),tokens:{access:'public-test'}},{...sample(origin),local:[['x','x'.repeat(65537)]]},'x'.repeat(270000)])assert.equal((await post(value)).status,400);
 assert.deepEqual(await readdir(directory),[]);
}));
test('invalid ownership, origin, time, duplicate keys and unknown inventory shapes fail closed',()=>{
 const origin='http://127.0.0.1:45123',now=Date.now(),options={owner,nonce,origin,startedAt:now-1000,now};
 for(const patch of [{owner:actor},{origin:'http://localhost:45123'},{capturedAt:now-2000},{capturedAt:now+1001},{local:[['a','1'],['a','2']]},{cacheNames:['same','same']},{indexedDbNames:[{}]},{recoveryView:null}])assert.throws(()=>validateColdBrowserPageCaptureV2({...sample(origin),...patch},options));
});
test('page receipt digest, final local/session inventories and real request session are inseparable',()=>{
 const origin='http://127.0.0.1:45123',value=sample(origin),envelope={format:'IDMS_COLD_BROWSER_PAGE_RECEIPT_V2',owner,nonce,index:1,stage:'active',acceptedAt:Date.now(),sessionCookieHash:hash,bodySha256:sha(JSON.stringify(value)),snapshot:value},options={owner,nonce,origin,stage:'active',index:1,expectedSessionHash:hash,startedAt:value.capturedAt-1000};
 assert(verifyColdBrowserPageSnapshotBindingV2(envelope,snapshot(value),options));
 assert.throws(()=>verifyColdBrowserPageSnapshotBindingV2({...envelope,bodySha256:'b'.repeat(64)},snapshot(value),options),/DIGEST/);
 for(const field of ['local','session','indexedDbNames','cacheNames'])assert.throws(()=>verifyColdBrowserPageSnapshotBindingV2(envelope,{...snapshot(value),[field]:field==='local'||field==='session'?[['hidden','value']]:['unknown']},options),/SNAPSHOT_BINDING/);
 assert.throws(()=>verifyColdBrowserPageSnapshotBindingV2(envelope,snapshot(value),{...options,expectedSessionHash:null}),/SESSION_BINDING/);
});
test('the original strict storage verifier still rejects extra cookies and unknown persistent keys',()=>{
 const origin='http://127.0.0.1:45123',value=sample(origin),options={owner,nonce,origin,accounts:[{id:actor,tenantId:'sandbox'}],expectedSessionHash:null,startedAt:value.capturedAt-1000,permittedReferenceIds:[]};
 assert(verifyColdBrowserStorageSnapshotV1(snapshot(value),options));assert.throws(()=>verifyColdBrowserStorageSnapshotV1(snapshot(value,[{name:'unowned_cookie'}]),options),/COOKIE_COUNT/);assert.throws(()=>verifyColdBrowserStorageSnapshotV1({...snapshot(value),local:[['access_token','public-test-value']]},options),/UNCLASSIFIED_KEY/);
});
test('HTML instrumentation preserves exact UTF-8 length and existing CSP; private captures are not served',()=>fixture(async({origin,post})=>{
 const response=await fetch(origin+'/maintenance/'),body=Buffer.from(await response.arrayBuffer());assert.equal(Number(response.headers.get('content-length')),body.length);assert.match(body.toString('utf8'),/维修测试页/);assert.match(body.toString('utf8'),/采集本页存储/);assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);
 const script=await fetch(origin+'/__qa/browser-storage-v2/collector.js');assert.equal(script.status,200);assert.match(await script.text(),/indexedDB\.databases/);assert.equal((await fetch(origin+'/__qa/browser-storage-v2/browser-page-storage-0001.private.json')).status,400);
 assert.equal((await post(sample(origin))).status,201);assert.equal((await fetch(origin+'/browser-page-storage-0001.private.json')).status,404);
}));
test('independent Cookie seal rejects changed implementation, cookie inventory, scope or observation time',()=>{
 const origin='http://127.0.0.1:45123',value=sample(origin),envelope={format:'IDMS_COLD_BROWSER_PAGE_RECEIPT_V2',owner,nonce,index:1,stage:'active',acceptedAt:Date.now(),sessionCookieHash:null,bodySha256:sha(JSON.stringify(value)),snapshot:value},final=snapshot(value),pageBytes=Buffer.from(JSON.stringify(envelope)),snapshotBytes=Buffer.from(JSON.stringify(final)+'\n'),adapterSha256='b'.repeat(64);
 const seal={format:'IDMS_COLD_BROWSER_PAGE_SEAL_V2',owner,nonce,index:1,stage:'active',pageFile:'browser-page-storage-0001.private.json',file:'browser-storage-0001.private.json',pageFileSha256:sha(pageBytes),pageBodySha256:envelope.bodySha256,snapshotSha256:sha(snapshotBytes),implementationSha256:adapterSha256,cookieReadMethod:'Network.getCookies',rawCookieValuesPersisted:false,rawStorageValuesDisplayed:false,cookiePaths:['/','/maintenance/','/governance/','/predictive/','/reconciliation/','/api/v1/auth/login','/api/v1/auth/callback','/api/v1/auth/session','/api/v1/auth/logout'],cookieCapturedAt:Date.now(),cookieCount:0,cookieMetadataSha256:sha(JSON.stringify(final.cookies))};
 const options={pageBytes,snapshotBytes,adapterSha256};assert(verifyColdBrowserCookieSealV2(seal,envelope,final,options));
 for(const patch of [{implementationSha256:hash},{cookieCount:1},{cookiePaths:['/']},{cookieCapturedAt:value.capturedAt+30001},{pageFileSha256:hash},{snapshotSha256:hash},{rawCookieValuesPersisted:true}])assert.throws(()=>verifyColdBrowserCookieSealV2({...seal,...patch},envelope,final,options));
});
