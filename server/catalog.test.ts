import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import test from 'node:test';
import {approveTemplate,activatePlugin,certifyPlugin,createPlugin,createTemplate,editTemplate,exportTemplate,importTemplate,pluginContentDigest,pluginMetadataStatus,presentTemplate,submitTemplate,templateContentDigest} from './catalog.ts';
import type {Plugin} from './domain.ts';
import type {AccessContext} from './access.ts';
import {requireAccess} from './access.ts';
import {seedStore} from './store.ts';
import {verifyAuditChain} from './audit.ts';
import {approvePredictiveAlert} from './predictive.ts';
import {changeWorkOrder} from './maintenance.ts';
import {validateManifest} from './template-schema.ts';
const ctx=(actorId:string,roles:string[],tenantId='acme'):AccessContext=>({tenantId,actorId,actorType:'USER',correlationId:randomUUID(),authMode:'oidc',roles});
const designer=ctx('designer',['tenant-admin']),publisher=ctx('publisher',['final-approver']),tech=ctx('tech',['maintenance-engineer','final-approver']);
const manifest=(fields:unknown[]=[{key:'post_vibration',label:'复测振动',type:'NUMBER',required:true,unit:'mm/s',min:0,max:20}])=>({schemaVersion:1,minPlatformVersion:'0.1.0',modules:['maintenance'],policy:{finalApproval:'INDEPENDENT_HUMAN',deviceAccess:'READ_ONLY'},maintenance:{fields}});
const expected=(t:any)=>({expectedDigest:t.contentDigest,expectedRevision:t.revision});
function publish(store:any,version='1.0.0',fields?:unknown[]){const t=createTemplate(store,{templateKey:'maintenance-form',version,industry:'机加工',manifest:manifest(fields)},designer);submitTemplate(store,t.id,expected(t),designer);approveTemplate(store,t.id,{...expected(t),decision:'APPROVED',comment:'独立核查模板'},publisher);return t;}

test('catalog rejects forged permission lists, administrators, interfaces and AI final actions',()=>{
 const store=seedStore();
 assert.throws(()=>createTemplate(store,{},ctx('spoof',[])),/权限/);
 assert.throws(()=>createTemplate(store,{}, {...designer,roles:[],permissions:['template:edit']}),/权限/);
 for(const role of ['tenant-admin','system-admin','platform-certifier'])assert.throws(()=>requireAccess(ctx('admin',[role]),'template:publish'),/权限/);
 for(const p of ['template:publish','plugin:activate','approve','maintenance:approve'])assert.throws(()=>requireAccess(ctx('platform',['system-admin','final-approver']),p),/权限/);
 for(const actorType of ['AI','INTERFACE','SYSTEM'])for(const p of ['template:publish','plugin:activate'])assert.throws(()=>requireAccess({...publisher,actorType},p));
 assert.throws(()=>requireAccess({...ctx('cert',['platform-certifier']),actorType:'INTERFACE'},'plugin:certify'));
});
test('template schema rejects unsafe policies, incompatible versions, duplicate/reserved fields and unknowns',()=>{
 for(const bad of [{...manifest(),script:'run'},{...manifest(),minPlatformVersion:'99.0.0'},{...manifest(),policy:{finalApproval:'AI',deviceAccess:'WRITE'}},manifest([{key:'state',label:'x',type:'TEXT',required:true}]),manifest([{key:'x',label:'x',type:'NUMBER',required:true,min:2,max:1}]),manifest([{key:'x',label:'x',type:'SELECT',required:true,options:['a','a']}])])assert.throws(()=>validateManifest(bad));
 assert.throws(()=>createTemplate(seedStore(),{templateKey:'maintenance-form',version:'01.0.0',industry:'制造',manifest:manifest()},designer));
 assert.throws(()=>createTemplate(seedStore(),{templateKey:'maintenance-form',version:'1.0.0',industry:'制造',manifest:manifest(),tenantId:'sandbox'},designer),/保留/);
});
test('draft edits and submission freeze input, require expected revision and prohibit every contributing author from self approval',()=>{
 const s=seedStore(),t=createTemplate(s,{templateKey:'maintenance-form',version:'1.0.0',industry:'制造',manifest:manifest()},designer);
 const old=expected(t),before=structuredClone(t);
 editTemplate(s,t.id,{...old,manifest:manifest([])},ctx('editor',['tenant-admin']));
 assert.throws(()=>submitTemplate(s,t.id,old,designer),/已变化/);
 submitTemplate(s,t.id,expected(t),ctx('submitter',['tenant-admin']));
 assert.throws(()=>editTemplate(s,t.id,{...expected(t),manifest:manifest()},designer),/不可编辑/);
 for(const id of ['designer','editor','submitter'])assert.throws(()=>approveTemplate(s,t.id,{...expected(t),decision:'APPROVED',comment:'自审'},ctx(id,['final-approver'])),/不得终审/);
 t.manifest.policy={finalApproval:'AI'};assert.throws(()=>approveTemplate(s,t.id,{...expected(t),decision:'APPROVED',comment:'篡改'},publisher),/摘要/);
 assert.deepEqual(s.audits.find(a=>a.action==='DRAFT_CREATED')!.after,before);
});
test('publication retires only routing status, retains correct before audit, and rejects downgrade/racing older draft',()=>{
 const s=seedStore(),a=publish(s),snapshot=structuredClone(a.manifest);
 const older=createTemplate(s,{templateKey:'maintenance-form',version:'1.1.0',industry:'制造',manifest:manifest()},designer);submitTemplate(s,older.id,expected(older),designer);
 const b=publish(s,'1.2.0',[]);assert.equal(a.status,'RETIRED');assert.deepEqual(a.manifest,snapshot);
 const retired=s.audits.find(x=>x.action==='RETIRED_BY_NEW_VERSION')!;assert.equal((retired.before as any).status,'PUBLISHED');assert.equal((retired.after as any).status,'RETIRED');
 assert.throws(()=>approveTemplate(s,older.id,{...expected(older),decision:'APPROVED',comment:'旧版覆盖'},publisher),/已经更新/);
 assert.throws(()=>createTemplate(s,{templateKey:'maintenance-form',version:'1.0.0',industry:'制造',manifest:manifest()},designer),/已存在/);
 assert.equal(b.status,'PUBLISHED');assert.equal(verifyAuditChain(s.audits,'acme'),true);
});
test('returned template is immutable; portable export binds content and import creates a new draft without copied approval',()=>{
 const s=seedStore(),t=publish(s),pack=exportTemplate(s,t.id,publisher);
 const target=seedStore(),imported=importTemplate(target,pack,ctx('other-designer',['tenant-admin'],'sandbox'));
 assert.equal(imported.tenantId,'sandbox');assert.equal(imported.status,'DRAFT');assert.equal(imported.publishedBy,undefined);assert.equal(imported.contentDigest,t.contentDigest);
 submitTemplate(target,imported.id,expected(imported),ctx('other-designer',['tenant-admin'],'sandbox'));
 approveTemplate(target,imported.id,{...expected(imported),decision:'RETURNED',comment:'补充说明'},ctx('other-publisher',['final-approver'],'sandbox'));
 assert.throws(()=>editTemplate(target,imported.id,{...expected(imported),manifest:manifest([])},ctx('other-designer',['tenant-admin'],'sandbox')),/不可编辑/);
 assert.throws(()=>exportTemplate(s,t.id,ctx('foreign',['auditor'],'sandbox')),/不存在/);
 const tampered=structuredClone(pack);tampered.content.industry='改动';assert.throws(()=>importTemplate(seedStore(),tampered,designer),/摘要/);
 assert.equal(presentTemplate(s.templates[0]).validated,false);
});
test('new work orders freeze published field schema; old orders keep old version and typed evidence is independently approved',()=>{
 const s=seedStore(),t=publish(s);
 approvePredictiveAlert(s,'palert-001','APPROVED','创建工单',publisher);const o=s.workOrders[0];assert.equal(o.templateBinding?.version,'1.0.0');
 const alert=structuredClone(s.predictiveAlerts[0]);Object.assign(alert,{id:randomUUID(),state:'AWAITING_APPROVAL',version:1,workOrderId:undefined});s.predictiveAlerts.push(alert);
 s.maintenanceRecommendations.push({...s.maintenanceRecommendations[0],id:randomUUID(),alertId:alert.id,status:'PROPOSED'});
 publish(s,'1.1.0',[{key:'tested',label:'复测完成',type:'BOOLEAN',required:true}]);approvePredictiveAlert(s,alert.id,'APPROVED','新版工单',publisher);
 assert.equal(s.workOrders[1].templateBinding?.version,'1.1.0');assert.equal(o.templateBinding?.version,t.version);
 changeWorkOrder(s,o.id,'claim',{expectedVersion:o.version},tech);changeWorkOrder(s,o.id,'start',{expectedVersion:o.version},tech);
 const evidence={expectedVersion:o.version,failureCode:'BRG',cause:'轴承磨损',action:'维修措施',verification:'复测依据',minutes:30,partsUsed:[]};
 for(const customFields of [{},{post_vibration:'3'},{post_vibration:100},{post_vibration:3,approved:true}])assert.throws(()=>changeWorkOrder(s,o.id,'submit',{...evidence,customFields},tech));
 changeWorkOrder(s,o.id,'submit',{...evidence,customFields:{post_vibration:3.2}},tech);
 assert.equal(o.resolution?.customFields?.post_vibration,3.2);assert.equal(o.resolution?.templateDigest,o.templateBinding?.bindingDigest);
 assert.throws(()=>changeWorkOrder(s,o.id,'approval',{expectedVersion:o.version,decision:'APPROVED',comment:'自审',snapshotDigest:o.resolution!.digest},tech));
 changeWorkOrder(s,o.id,'approval',{expectedVersion:o.version,decision:'APPROVED',comment:'独立核查',snapshotDigest:o.resolution!.digest},publisher);assert.equal(o.state,'CLOSED');assert.equal(verifyAuditChain(s.audits,'acme'),true);
});

test('trusted manifest signatures bind tenant, current content and declared scope, and never authorize runtime',()=>{
 const s=seedStore(),pair=generateKeyPairSync('ed25519'),key={keyId:'qa-key',publicKey:pair.publicKey.export({format:'der',type:'spki'}).toString('base64'),pluginTypes:['metric-provider'],permissions:['device:read'],tenantIds:['acme'],expiresAt:'2099-01-01T00:00:00Z',revoked:false},trust=new Map([[key.keyId,key]]);
 const input={name:'QA metric',type:'metric-provider' as const,version:'1.0.0',permissions:['device:read'],manifest:{minPlatformVersion:'0.1.0',artifactSha256:'a'.repeat(64),networkTargets:[],maxMemoryMb:64},signingKeyId:key.keyId};
 const signed={...input,signature:sign(null,Buffer.from(pluginContentDigest({...input,tenantId:'acme'})),pair.privateKey).toString('base64')};
 assert.throws(()=>createPlugin(s,{...signed,publicKey:key.publicKey},designer,trust),/保留/);
 const p=createPlugin(s,signed,designer,trust);assert.equal(p.signed,true);assert.equal(p.status,'DRAFT');
 assert.equal(pluginMetadataStatus({...p,tenantId:'sandbox'},trust).valid,false);
 assert.equal(pluginMetadataStatus({...p,manifest:{...p.manifest,maxMemoryMb:512}},trust).valid,false);
 assert.equal(pluginMetadataStatus(p,new Map([[key.keyId,{...key,revoked:true}]] )).valid,false);
 assert.equal(pluginMetadataStatus(p,new Map([[key.keyId,{...key,expiresAt:'2000-01-01'}]])).valid,false);
 assert.equal(pluginMetadataStatus(p,new Map([[key.keyId,{...key,permissions:[]}]] )).valid,false);
 assert.equal(pluginMetadataStatus(s.plugins[0],trust).valid,false);
 assert.throws(()=>certifyPlugin(s,p.id,ctx('cert',['platform-certifier']),trust),/尚未验收/);
 assert.throws(()=>activatePlugin(s,p.id,publisher),/失败关闭/);
 assert.throws(()=>activatePlugin(s,s.plugins[0].id,publisher),/失败关闭/);
 assert.throws(()=>certifyPlugin(s,p.id,designer,trust),/权限/);
 assert.throws(()=>createPlugin(s,signed,designer,trust),/已存在/);
 assert.equal(p.status,'DRAFT');assert.equal(verifyAuditChain(s.audits,'acme'),true);
});

