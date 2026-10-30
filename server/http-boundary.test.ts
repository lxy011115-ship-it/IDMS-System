import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {beginHttpResponse,publicFailure,failureDiagnostic,readPublicAsset} from './http-boundary.ts';
import {DomainError} from './service.ts';

test('static assets distinguish 404, invalid paths, root page and the explicit style alias',async()=>{
 const workspace=resolve('work/http-boundary-qa');await mkdir(workspace,{recursive:true});const root=await mkdtemp(join(workspace,'case-'));
 try{await mkdir(join(root,'public'));await mkdir(join(root,'src'));await writeFile(join(root,'public/index.html'),'<h1>IDMS</h1>');await writeFile(join(root,'src/styles.css'),'body{}');
  assert.equal((await readPublicAsset('/',root)).file.toString(),'<h1>IDMS</h1>');assert.match((await readPublicAsset('/styles.css',root)).contentType,/text\/css/);
  await assert.rejects(readPublicAsset('/missing.js',root),(e:unknown)=>e instanceof DomainError&&e.status===404&&!e.message.includes(root));
  for(const path of ['/../private','/..%5c.local%5cprivate','/%00','/%xx'])await assert.rejects(readPublicAsset(path,root),(e:unknown)=>e instanceof DomainError&&e.status===400);
 }finally{if(!resolve(root).startsWith(workspace+sep))throw Error('Unsafe QA cleanup');await rm(root,{recursive:true,force:true});}
});
test('unexpected failures never expose internal paths, SQL or credentials',()=>{
 const err=Object.assign(Error('D:\\private secret-password SQL select *'),{code:'42P01'}),r=publicFailure(err,'trace-id');assert.equal(r.status,500);assert.equal(r.body.requestId,'trace-id');assert.doesNotMatch(JSON.stringify(r),/secret-password|private|select \*/);assert.deepEqual(failureDiagnostic(err,'trace-id'),{requestId:'trace-id',errorName:'Error',errorCode:'42P01'});
 assert.deepEqual(publicFailure(new DomainError(409,'库存不足'),'trace-id'),{status:409,body:{error:'库存不足'}});
});
test('response baseline has a server-generated trace, safe headers and observation-only CSP',()=>{
 const headers=new Map(),res={setHeader:(k:string,v:string)=>headers.set(k.toLowerCase(),v)};const id=beginHttpResponse(res as any);assert.match(id,/^[a-f0-9-]{36}$/);assert.equal(headers.get('x-request-id'),id);assert.equal(headers.get('x-content-type-options'),'nosniff');assert.equal(headers.get('referrer-policy'),'same-origin');assert.match(headers.get('content-security-policy-report-only'),/script-src 'self'/);assert.equal(headers.has('content-security-policy'),false);assert.equal(headers.has('strict-transport-security'),false);
});
