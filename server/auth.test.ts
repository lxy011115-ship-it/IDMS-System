import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createAuth } from './auth.ts';
import { requireAccess, permissionsFor } from './access.ts';
import { seedStore } from './store.ts';
import { approvePredictiveAlert } from './predictive.ts';
import { changeWorkOrder } from './maintenance.ts';
let server:any, origin:string, auth:ReturnType<typeof createAuth>;
const keys=await generateKeyPair('RS256'), jwk={...await exportJWK(keys.publicKey),kid:'qa-key',alg:'RS256',use:'sig'};
before(async()=>{
  server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({keys:[jwk]}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  auth=createAuth({mode:'oidc',issuer:origin+'/realms/idms',audience:'idms-api',clientId:'idms-web',origin});
});
after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(resolve));});
async function token(extra:any={},key=keys.privateKey){return new SignJWT({tenant_id:'acme',typ:'Bearer',azp:'idms-web',realm_access:{roles:['auditor']},preferred_username:'qa-auditor',...extra}).setProtectedHeader({alg:'RS256',kid:'qa-key'}).setIssuer(origin+'/realms/idms').setAudience('idms-api').setSubject('real-sub').setIssuedAt().setExpirationTime('2m').sign(key);}
test('OIDC validates signature, tenant and roles and ignores spoofed actor headers',async()=>{
  const bearer=await token();const ctx=await auth.context({headers:{authorization:'Bearer '+bearer,'x-actor-id':'demo.approver','x-actor-type':'AI'}} as any);
  assert.equal(ctx.actorId,'real-sub');assert.equal(ctx.actorType,'USER');assert.equal(ctx.tenantId,'acme');assert.equal(ctx.authMode,'oidc');
  requireAccess(ctx,'read');assert.throws(()=>requireAccess(ctx,'approve'));
  await assert.rejects(()=>auth.context({headers:{authorization:'Bearer '+bearer,'x-tenant-id':'sandbox'}} as any),/企业/);
  await assert.rejects(()=>auth.context({headers:{'x-tenant-id':'acme','x-actor-id':'demo.approver'}} as any),/登录/);
});
test('missing/wrong tenant, audience, issuer, expired and forged tokens fail closed',async()=>{
  for(const extra of [{tenant_id:undefined},{tenant_id:['acme','sandbox']},{tenant_id:'../sandbox'},{azp:'other-client'},{typ:'ID'},{realm_access:{roles:[]}}])await assert.rejects(()=>token(extra).then(t=>auth.verify(t)));
  const badKeys=await generateKeyPair('RS256');await assert.rejects(()=>token({},badKeys.privateKey).then(t=>auth.verify(t)),/令牌/);
  for(const kind of ['audience','issuer','expired']){
    const signed=await new SignJWT({tenant_id:'acme',typ:'Bearer',azp:'idms-web',realm_access:{roles:['auditor']}}).setProtectedHeader({alg:'RS256',kid:'qa-key'}).setIssuer(kind==='issuer'?origin+'/realms/other':origin+'/realms/idms').setAudience(kind==='audience'?'other-api':'idms-api').setSubject('sub').setIssuedAt().setExpirationTime(kind==='expired'?Math.floor(Date.now()/1000)-60:'2m').sign(keys.privateKey);
    await assert.rejects(()=>auth.verify(signed));
  }
});
test('OIDC scoped roles require administrator-managed range claims',async()=>{
  const missing=await token({realm_access:{roles:['data-uploader']}});await assert.rejects(()=>auth.verify(missing),/数据范围/);
  const assigned=await token({realm_access:{roles:['data-uploader']},idms_sites:['FACTORY-02'],idms_lines:['*'],idms_devices:['*']});
  const ctx=(await auth.verify(assigned)).identity;assert.equal(ctx.scope?.provided,true);assert.deepEqual(ctx.scope?.sites,['FACTORY-02']);
});
test('real subjects claim and repair work orders; even combined roles cannot self approve',()=>{
  const store=seedStore();const reviewer={tenantId:'acme',actorId:'approver-sub',actorType:'USER',correlationId:'qa',authMode:'oidc' as const,roles:['final-approver']};
  const alert=approvePredictiveAlert(store,store.predictiveAlerts[0].id,'APPROVED','核查证据',reviewer),order=store.workOrders[0];
  assert.equal(order.state,'UNASSIGNED');assert.equal(order.assignee,'');assert.ok(alert.workOrderId);
  const engineer={...reviewer,actorId:'engineer-sub',roles:['maintenance-engineer','final-approver']};
  assert.throws(()=>changeWorkOrder(store,order.id,'claim',{expectedVersion:order.version},reviewer),/权限/);
  changeWorkOrder(store,order.id,'claim',{expectedVersion:order.version},engineer);assert.equal(order.assignee,'engineer-sub');
  changeWorkOrder(store,order.id,'start',{expectedVersion:order.version},engineer);
  changeWorkOrder(store,order.id,'submit',{expectedVersion:order.version,failureCode:'BRG',cause:'轴承磨损',action:'修复复测',verification:'复测正常',minutes:30,partsUsed:[]},engineer);
  assert.throws(()=>changeWorkOrder(store,order.id,'approval',{expectedVersion:order.version,snapshotDigest:order.resolution!.digest,decision:'APPROVED',comment:'自行关闭'},engineer),/不得终审/);
  changeWorkOrder(store,order.id,'approval',{expectedVersion:order.version,snapshotDigest:order.resolution!.digest,decision:'APPROVED',comment:'独立核查'},reviewer);assert.equal(order.state,'CLOSED');
  assert.throws(()=>requireAccess({...reviewer,roles:['tenant-admin']},'approve'));
  assert.equal(permissionsFor(['untrusted-role']).length,0);
});
