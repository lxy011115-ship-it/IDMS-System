import test from 'node:test';
import assert from 'node:assert/strict';
import {stock,type SparesState} from './spares.ts';
import {factKey,exactFact,relatedTotal,type SparesFacts} from './spares-facts.ts';
const facts=():SparesFacts=>({persistedIds:new Set(['old']),stocks:new Map([[factKey('p','w'),{quantityMilli:3000,revision:7}]]),supplierReturns:new Map(),issueReturns:new Map([['old',1000]]),issueInstalled:new Map(),documents:new Map(),codeConflict:false,documentConflict:false,linkConflict:false});
test('aggregate baselines do not double count loaded historical movements and include new in-command deltas',()=>{
 const s:SparesState={facts:facts(),entities:[{id:'old',kind:'movement',tenantId:'qa',siteCode:'F1',version:1,createdBy:'a',createdAt:'2026-10-30',partId:'p',warehouseId:'w',deltaMilli:-2000}]};assert.deepEqual(stock(s,'p','w'),{quantityMilli:3000,revision:7});s.entities.push({...s.entities[0],id:'new',type:'RETURN',issueId:'old',deltaMilli:500});assert.deepEqual(stock(s,'p','w'),{quantityMilli:3500,revision:8});assert.equal(relatedTotal(s,'issueReturns','old',e=>e.type==='RETURN'&&e.issueId==='old',e=>e.deltaMilli),1500);
});
test('missing or inexact facts fail closed instead of assuming zero stock or related quantities',()=>{
 const s:SparesState={entities:[],facts:facts()};assert.throws(()=>stock(s,'missing','w'),/缺少/);assert.throws(()=>relatedTotal(s,'documents','missing',()=>true,()=>0),/缺少/);for(const v of ['01','-0','1.0','1e3','9007199254740992','-1'])assert.throws(()=>exactFact(v));assert.equal(exactFact('-2',false),-2);assert.equal(exactFact('0'),0);
});
