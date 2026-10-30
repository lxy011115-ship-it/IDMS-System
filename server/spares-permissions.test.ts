import test from 'node:test';
import assert from 'node:assert/strict';
import {permissionsFor,requireAccess,type AccessContext} from './access.ts';
import {sparesCapabilities,spareVisible,sparesView,type SpareEntity} from './spares.ts';
const ctx=(roles:string[],actorType='USER'):AccessContext=>({tenantId:'qa',actorId:'actor',actorType,authMode:'oidc',roles,correlationId:'qa'});
test('central permission catalog matches existing spares responsibilities',()=>{
 const expected:Record<string,string[]>={'tenant-admin':['manage','request','move','finance'],'spare-parts-clerk':['manage','request','move','finance'],'data-uploader':['request'],'maintenance-engineer':['request','move'],'final-approver':['approve'],auditor:[],operator:[]};
 for(const [role,keys] of Object.entries(expected)){const c=sparesCapabilities(ctx([role]));assert.deepEqual(Object.entries(c).filter(([k,v])=>k!=='history'&&v).map(([k])=>k),keys);assert.equal(c.history,true);for(const key of keys)assert.ok(permissionsFor([role]).includes('spares:'+key));}
});
test('platform role stacking and nonhuman actors never get spares write capability',()=>{
 for(const role of ['tenant-admin','spare-parts-clerk','final-approver']){const c=sparesCapabilities(ctx(['system-admin',role]));assert.equal(Object.entries(c).some(([k,v])=>k!=='history'&&v),false);assert.throws(()=>requireAccess(ctx(['system-admin',role]),'spares:manage'));}
 for(const actor of ['AI','INTERFACE']){const c=sparesCapabilities(ctx(['tenant-admin','final-approver'],actor));assert.equal(Object.entries(c).some(([k,v])=>k!=='history'&&v),false);}
});
test('untrusted supplied permissions do not grant capabilities; demo identities use central grants',()=>{
 assert.equal(sparesCapabilities({...ctx([]),permissions:['spares:manage']}).manage,false);
 assert.equal(sparesCapabilities({...ctx([]),authMode:'demo',actorId:'demo.technician'}).move,true);
 assert.equal(sparesCapabilities({...ctx(['spare-parts-clerk']),authMode:'demo',actorId:'unknown'}).manage,false);
});

test('linked work-order visibility is rechecked without filtering shared warehouse stock',()=>{
 const base={tenantId:'qa',siteCode:'F1',createdBy:'clerk',createdAt:'2026-10-30T00:00:00Z',version:1},part={...base,id:'p',kind:'part',name:'泵备件',unit:'只',safetyMilli:0},warehouse={...base,id:'w',kind:'warehouse',name:'共享仓库'},move={...base,kind:'movement',partId:'p',warehouseId:'w',deviceCode:'P1'},own={...move,id:'own',type:'ISSUE',deltaMilli:-3000,workOrderId:'W1'},other={...move,id:'other',type:'ISSUE',deltaMilli:-2000,workOrderId:'W2'},receipt={...move,id:'receipt',type:'RECEIPT',deltaMilli:10000};
 const context={...ctx(['operator']),scope:{provided:true,sites:['F1'],lines:['*'],devices:['*']}},refs={devices:[{code:'P1',siteCode:'F1',name:'泵'}],orders:[{id:'W1',deviceCode:'P1',assignee:'actor',state:'IN_PROGRESS'}]};assert.equal(spareVisible(own,context,refs),true);assert.equal(spareVisible(other,context,refs),false);
 const view=sparesView({entities:[part,warehouse,receipt,own,other] as SpareEntity[]},context,refs);assert.equal(view.entities.some(e=>e.id==='other'),false);assert.equal(view.balances[0].quantityMilli,5000);assert.equal(spareVisible(own,context,{...refs,orders:[]}),false);
});
