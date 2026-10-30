import test from 'node:test';
import assert from 'node:assert/strict';
import {spareCommand,sparesView,stock,quantity,money,type SparesState,type SpareReferences} from './spares.ts';
import type {AccessContext} from './access.ts';
const ctx=(actor:string,roles:string[]):AccessContext=>({tenantId:'qa',actorId:actor,actorType:'USER',authMode:'oidc',roles,correlationId:'spares-unit',scope:{provided:true,sites:['F1'],lines:['*'],devices:['*']}});
const admin=ctx('clerk',['spare-parts-clerk']),approver=ctx('reviewer',['final-approver']),refs:SpareReferences={devices:[{code:'P-1',name:'泵',siteCode:'F1'}],orders:[]};
function fixture(){const state:SparesState={entities:[]};const run=(action:string,input:any,c=admin)=>spareCommand(state,action,input,c,refs)!;const supplier=run('supplier.create',{siteCode:'F1',code:'SUP-1',name:'供应商'}),warehouse=run('warehouse.create',{siteCode:'F1',code:'WH-1',name:'备件库'}),part=run('part.create',{siteCode:'F1',code:'BRG-1',name:'轴承',unit:'只',precision:0,safety:'2'});const purchase=run('purchase.create',{supplierId:supplier.id,warehouseId:warehouse.id,dueDate:'2026-12-01',lines:[{partId:part.id,quantity:'10',unitPrice:'12.34'}]});return {state,run,supplier,warehouse,part,purchase,act:(action:string,input:any={},c=admin)=>run(action,{id:purchase.id,expectedVersion:purchase.version,...input},c)};}
test('purchase approval, partial receipts, issue, return and supplier return conserve stock',()=>{
 const f=fixture();f.act('purchase.submit');f.act('purchase.approve',{decision:'APPROVED',comment:'核对采购依据'},approver);f.act('purchase.order');
 const r=f.act('purchase.receive',{lineId:f.purchase.lines[0].id,accepted:'6',reason:'验收合格'});assert.equal(f.purchase.status,'PART_RECEIVED');
 f.act('purchase.receive',{lineId:f.purchase.lines[0].id,accepted:'4',reason:'验收合格'});assert.equal(f.purchase.status,'RECEIVED');
 const issue=f.run('stock.issue',{partId:f.part.id,warehouseId:f.warehouse.id,quantity:'3',deviceCode:'P-1',reason:'维修领用'});
 f.run('stock.return',{id:issue.id,quantity:'1',reason:'未用退回'});f.run('stock.supplier-return',{id:r.id,quantity:'2',reason:'供应商退货'});
 assert.equal(stock(f.state,f.part.id,f.warehouse.id).quantityMilli,6000);assert.equal(f.purchase.lines[0].receivedMilli,8000);assert.equal(f.purchase.totalCents,12340);
 assert.throws(()=>f.run('stock.issue',{partId:f.part.id,warehouseId:f.warehouse.id,quantity:'7',deviceCode:'P-1',reason:'超领'}),/库存不足/);
 assert.throws(()=>f.run('stock.return',{id:issue.id,quantity:'3',reason:'超退'}),/超过/);
});
test('self approval, stale versions and unauthorized site cannot mutate the workflow',()=>{
 const f=fixture();assert.throws(()=>f.run('part.create',{siteCode:'F2',code:'X',name:'X',unit:'只'}),/范围/);f.act('purchase.submit');
 assert.throws(()=>f.act('purchase.approve',{decision:'APPROVED',comment:'自审'},ctx('clerk',['spare-parts-clerk','final-approver'])),/不能自审/);
 assert.throws(()=>f.run('purchase.approve',{id:f.purchase.id,expectedVersion:1,decision:'APPROVED',comment:'旧版'},approver),/版本已变化/);
 assert.equal(f.purchase.status,'SUBMITTED');assert.throws(()=>f.act('purchase.order'),/状态|已批准/);
});
test('stocktake/opening approval checks fresh ledger baseline and keeps installation separate',()=>{
 const f=fixture(),opening=f.run('adjustment.create',{partId:f.part.id,warehouseId:f.warehouse.id,type:'OPENING',quantity:'5',reason:'期初清点'});
 assert.throws(()=>f.run('adjustment.approve',{id:opening.id,expectedVersion:1,decision:'APPROVED',comment:'自审'},ctx('clerk',['spare-parts-clerk','final-approver'])),/不能自审/);
 f.run('adjustment.approve',{id:opening.id,expectedVersion:1,decision:'APPROVED',comment:'核对实物'},approver);
 const count=f.run('adjustment.create',{partId:f.part.id,warehouseId:f.warehouse.id,type:'COUNT',quantity:'4',reason:'盘点差异'}),issue=f.run('stock.issue',{partId:f.part.id,warehouseId:f.warehouse.id,deviceCode:'P-1',quantity:'2',reason:'更换用料'});
 assert.throws(()=>f.run('adjustment.approve',{id:count.id,expectedVersion:1,decision:'APPROVED',comment:'复核'},approver),/库存已变化/);
 const link=f.run('link.create',{partId:f.part.id,deviceCode:'P-1',position:'前轴承',quantity:'1',cycleDays:90});assert.equal(link.lastDate,'');
 f.run('replacement.create',{id:issue.id,linkId:link.id,quantity:'1',date:new Date().toISOString().slice(0,10),reason:'实际更换完成'});assert.equal(stock(f.state,f.part.id,f.warehouse.id).quantityMilli,3000);
 assert.throws(()=>f.run('stock.return',{id:issue.id,quantity:'2',reason:'已安装不能退'}),/超过/);
 assert.ok(sparesView(f.state,admin,refs).reminders[0].dueDate);
});
test('fixed precision, financial entries and disabled catalogs fail closed',()=>{
 assert.equal(quantity('1.125'),1125);assert.equal(money('12.34'),1234);assert.throws(()=>quantity('0.1',0));assert.throws(()=>money('1.001'));
 const f=fixture();f.act('purchase.submit');f.act('purchase.approve',{decision:'APPROVED',comment:'独立批准'},approver);f.act('purchase.order');
 const doc={id:f.purchase.id,type:'PAYMENT',number:'V1',date:new Date().toISOString().slice(0,10),amount:'123.40',reason:'凭证登记'};f.run('document.create',doc);assert.throws(()=>f.run('document.create',doc),/已登记/);assert.throws(()=>f.run('document.create',{...doc,number:'V2',amount:'0.01'}),/超过/);
 assert.equal(sparesView(f.state,admin,refs).purchases[0].financeReview,true);
 f.run('supplier.update',{id:f.supplier.id,expectedVersion:1,active:false});assert.throws(()=>f.run('purchase.create',{supplierId:f.supplier.id,warehouseId:f.warehouse.id,dueDate:'2026-12-01',lines:[{partId:f.part.id,quantity:'1',unitPrice:'1'}]}),/停用/);
 assert.equal(sparesView(f.state,{...admin,tenantId:'other'},refs).entities.length,0);
});

test('counted units cannot opt into fractional stock precision',()=>{const f=fixture();assert.throws(()=>f.run('part.create',{siteCode:'F1',code:'X',name:'计数轴承',unit:'只',precision:3}),/整数精度/);});
