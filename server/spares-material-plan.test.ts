import test from 'node:test';
import assert from 'node:assert/strict';
import {spareCommand,stock,type SparesState,type SpareReferences} from './spares.ts';
import {remainingMaterialDemand} from './spares-material-plan.ts';
import {SparesAuditChain,spareEventHash} from './spares-audit-chain.ts';
import {canonical,digest} from './imports.ts';
const clerk={tenantId:'qa',actorId:'clerk',actorType:'USER' as const,authMode:'oidc' as const,roles:['spare-parts-clerk'],correlationId:'material-plan-test'};
function fixture(){
 const state:SparesState={entities:[]},refs:SpareReferences={devices:[{code:'PUMP-1',name:'泵',siteCode:'F1'}],orders:[{id:'ORDER-1',deviceCode:'PUMP-1',assignee:'tech',state:'IN_PROGRESS'}]};
 const run=(action:string,input:any,ctx=clerk)=>spareCommand(state,action,input,ctx,refs)!;
 const part=run('part.create',{siteCode:'F1',code:'BRG-1',name:'轴承',unit:'只',precision:0,safety:'3'}),warehouse=run('warehouse.create',{siteCode:'F1',code:'W-1',name:'备件库'});
 const input={partId:part.id,warehouseId:warehouse.id,workOrderId:'ORDER-1',quantity:'8',needDate:'2026-12-01',reason:'工单维修用料'};
 return {state,refs,run,part,warehouse,input};
}
test('material plans derive immutable device/site references, enforce unique tuples and never reserve or change stock',()=>{
 const f=fixture(),before=stock(f.state,f.part.id,f.warehouse.id);const plan=f.run('material-plan.create',f.input);
 assert.equal(plan.deviceCode,'PUMP-1');assert.equal(plan.siteCode,'F1');assert.equal(plan.quantityMilli,8000);assert.equal(plan.status,'ACTIVE');assert.deepEqual(stock(f.state,f.part.id,f.warehouse.id),before);
 assert.throws(()=>f.run('material-plan.create',f.input),/已有计划/);assert.throws(()=>f.run('material-plan.create',{...f.input,siteCode:'F2'}),/范围|不支持/);
 assert.throws(()=>f.run('material-plan.edit',{id:plan.id,expectedVersion:1,...f.input,workOrderId:'OTHER'}),/不支持|范围/);assert.equal(plan.version,1);
 const edited=f.run('material-plan.edit',{id:plan.id,expectedVersion:1,quantity:'10',needDate:'2026-12-02',reason:'核对后增补'});assert.equal(edited.quantityMilli,10000);
 assert.throws(()=>f.run('material-plan.edit',{id:plan.id,expectedVersion:1,quantity:'9',needDate:'2026-12-03',reason:'旧版本'}),/版本已变化/);
});
test('only existing managers or the current assigned repair operator can maintain a plan, including role stacking and transfer',()=>{
 const f=fixture(),tech={...clerk,actorId:'tech',roles:['maintenance-engineer']};assert.ok(f.run('material-plan.create',f.input,tech));
 for(const roles of [['data-uploader'],['auditor'],['final-approver'],['system-admin','spare-parts-clerk']])assert.throws(()=>f.run('material-plan.create',f.input,{...clerk,roles}),/权限/);
 const plan=f.state.entities.find(e=>e.kind==='material-plan')!;f.refs.orders[0].assignee='other';assert.throws(()=>f.run('material-plan.close',{id:plan.id,expectedVersion:1,reason:'不再本人负责'},tech),/权限|不能/);
 f.refs.orders[0].assignee='tech';f.refs.orders[0].state='AWAITING_APPROVAL';assert.throws(()=>f.run('material-plan.edit',{id:plan.id,expectedVersion:1,quantity:'7',needDate:'2026-12-01',reason:'待审不可编制'},tech),/维修中/);
 assert.ok(f.run('material-plan.close',{id:plan.id,expectedVersion:1,reason:'维修用料完成'},tech));
});
test('closed/cancelled plans retain usage and need explicit reopening; closed orders cannot regain demand through edits',()=>{
 const f=fixture(),plan=f.run('material-plan.create',f.input);assert.deepEqual(remainingMaterialDemand(plan as any,3000,'IN_PROGRESS'),{remainingMilli:5000,overPlanMilli:0,reserved:false});
 assert.equal(remainingMaterialDemand(plan as any,9000,'IN_PROGRESS').overPlanMilli,1000);assert.equal(remainingMaterialDemand(plan as any,9000,'IN_PROGRESS').remainingMilli,0);
 f.run('material-plan.close',{id:plan.id,expectedVersion:1,reason:'本次需求完成'});assert.equal(remainingMaterialDemand(plan as any,3000,'IN_PROGRESS').remainingMilli,0);
 assert.throws(()=>f.run('material-plan.edit',{id:plan.id,expectedVersion:2,quantity:'9',needDate:'2026-12-01',reason:'不可自动恢复'}),/人工恢复/);
 f.refs.orders[0].state='CLOSED';assert.throws(()=>f.run('material-plan.reopen',{id:plan.id,expectedVersion:2,reason:'工单已关'}),/工单已关闭/);assert.equal(plan.status,'CLOSED');
 f.refs.orders[0].state='IN_PROGRESS';f.run('material-plan.reopen',{id:plan.id,expectedVersion:2,reason:'重新核对需求'});assert.equal(remainingMaterialDemand(plan as any,3000,'CLOSED').remainingMilli,0);
 f.run('material-plan.cancel',{id:plan.id,expectedVersion:3,reason:'取消未用需求'});assert.equal(plan.status,'CANCELLED');assert.equal(plan.quantityMilli,8000);assert.equal(f.state.entities.filter(e=>e.kind==='material-plan').length,1);
});
test('invalid quantities, dates, scope, inactive catalogs and ambiguous payloads fail without changing the plan',()=>{
 const f=fixture();for(const patch of [{quantity:'0'},{quantity:'1.5'},{needDate:'2026-02-30'},{deviceCode:'PUMP-1'},{reason:''},{status:'ACTIVE'}])assert.throws(()=>f.run('material-plan.create',{...f.input,...patch}));
 assert.equal(f.state.entities.some(e=>e.kind==='material-plan'),false);f.part.active=false;assert.throws(()=>f.run('material-plan.create',f.input),/停用/);f.part.active=true;
 f.refs.devices[0].siteCode='F2';assert.throws(()=>f.run('material-plan.create',f.input),/同工厂/);f.refs.devices=[];assert.throws(()=>f.run('material-plan.create',f.input),/批准设备/);
});
test('versioned audit events preserve legacy hashes while refusing downgrade, relabeling and unknown protocols',()=>{
 const f=fixture(),plan=f.run('material-plan.create',f.input);const old={tenantId:'qa',actor:'clerk',action:'part.create',at:new Date().toISOString(),previousHash:'GENESIS',before:[null],after:[f.part]};
 const first={sequence:'1',site_code:'F1',body:old,hash:digest(canonical(old))};const chain=new SparesAuditChain('qa');chain.accept(first);
 const body={...old,wireVersion:2,action:'material-plan.create',previousHash:first.hash,after:[plan]},hash=spareEventHash(body);assert.notEqual(hash,digest(canonical(body)));
 chain.accept({sequence:'2',site_code:'F1',body,hash});assert.equal(chain.finish('2').previous,hash);
 for(const changed of [{...body,wireVersion:undefined},{...body,wireVersion:1},{...body,wireVersion:3}]){const check=new SparesAuditChain('qa');check.accept(first);assert.throws(()=>check.accept({sequence:'2',site_code:'F1',body:changed,hash}),/历史暂无法核验/);}
});
