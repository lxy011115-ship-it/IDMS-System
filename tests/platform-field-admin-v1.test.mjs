import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {createPlatformFieldAdminQaV1} from '../scripts/fixtures/platform-field-admin-v1-qa.mjs';

test('long-running native setup obtains a fresh admin token for every operation instead of reusing the expired factory token',async t=>{
 const user='qa-admin',password=randomBytes(32).toString('hex'),tokens=new Set();let issued=0,accepted=0,reused=0;
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks).toString();
  if(req.url==='/realms/master/protocol/openid-connect/token'){
   const form=new URLSearchParams(body);assert.equal(req.method,'POST');assert.equal(form.get('username'),user);assert.equal(form.get('password'),password);assert.equal(form.get('client_id'),'admin-cli');assert.equal(form.get('grant_type'),'password');
   const token=randomBytes(32).toString('base64url');tokens.add(token);issued++;res.setHeader('content-type','application/json');res.end(JSON.stringify({access_token:token}));return;
  }
  const token=req.headers.authorization?.replace(/^Bearer /,'');
  if(!tokens.delete(token)){reused++;res.writeHead(401);res.end();return;}
  accepted++;assert(req.url.startsWith('/admin/realms/fence-qa/'));
  if(req.method==='POST'){assert.deepEqual(JSON.parse(body),{enabled:true});res.writeHead(204);res.end();return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true}));
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));
 const api=createPlatformFieldAdminQaV1({issuer:'http://127.0.0.1:'+server.address().port+'/realms/fence-qa',admin:{username:user,password}});
 assert.deepEqual(await api('fence-qa/users'),{ready:true});
 assert.equal(await api('fence-qa/users','POST',{enabled:true}),null);
 assert.deepEqual(await api('fence-qa/roles/auditor'),{ready:true});
 assert.equal(issued,3);assert.equal(accepted,3);assert.equal(reused,0);assert.equal(tokens.size,0);
});
