import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayWorkspace,coverageReplayView} from '../public/coverage-replay-ui.js';
import {replayQuery} from './coverage-replay-sql.ts';
const now=Date.parse('2026-10-16T00:00:00Z'),query={source:'UPLOADS',deviceCode:'DEVICE-A',from:'2026-10-15T00:00:00Z',to:'2026-10-15T00:10:00Z',knownAt:new Date(now).toISOString()};
test('historical query requires exact source window known cutoff and rejects future and scope overrides',()=>{
 assert.equal(replayQuery(new URLSearchParams(query),now).source,'UPLOADS');for(const raw of [{...query,knownAt:''},{...query,source:'CURRENT'},{...query,source:'UPLOADS',edgeId:'edge-a'},{...query,knownAt:new Date(now+1).toISOString()},{...query,tenantId:'sandbox'},{...query,planMode:'CURRENT'},{...query,status:'ALL'}])assert.throws(()=>replayQuery(new URLSearchParams(raw),now));const duplicate=new URLSearchParams(query);duplicate.append('deviceCode','OTHER');assert.throws(()=>replayQuery(duplicate,now));
});
test('historical preview late source, filter or identity responses cannot restore old results or create requests',async()=>{
 const m=new ReplayWorkspace(now);m.setFilters(query);let release!:(v:any)=>void;const pending=m.preview(()=>new Promise(ok=>release=ok),()=> 'actor');m.setFilters({...query,source:'TELEMETRY'});release({source:'UPLOADS',deviceCode:'DEVICE-A',knownAt:query.knownAt,replayScope:'FROZEN_ALL_INPUTS',inputDigest:'a'.repeat(64)});await pending;assert.equal(m.result,null);assert.throws(()=>m.freezeRequest());
 let owner='a';m.setFilters(query);const next=m.preview(()=>new Promise(ok=>release=ok),()=>owner);m.clear('b',now);owner='b';release({source:'UPLOADS',deviceCode:'DEVICE-A',knownAt:query.knownAt,replayScope:'FROZEN_ALL_INPUTS'});await next;assert.equal(m.result,null);assert.equal(m.filters.deviceCode,'');
});
test('preview failures clear previous freeze evidence and retry keys stay stable only within one identity',async()=>{
 const m=new ReplayWorkspace(now);m.setFilters(query);await m.preview(async()=>({source:'UPLOADS',deviceCode:'DEVICE-A',knownAt:query.knownAt,replayScope:'FROZEN_ALL_INPUTS',inputDigest:'a'.repeat(64)}),()=> 'actor');const input=m.freezeRequest(),key=m.commandKey('/coverage-reports',input);assert.equal(m.commandKey('/coverage-reports',input),key);assert.notEqual(m.commandKey('/coverage-reports',{...input,title:'另建'}),key);
 await assert.rejects(m.preview(async()=>{throw Error('快照失败');},()=> 'actor'));assert.equal(m.result,null);assert.equal(m.previewQuery,null);assert.equal(m.error,'快照失败');assert.throws(()=>m.freezeRequest());m.clear('other',now);assert.notEqual(m.commandKey('/coverage-reports',input),key);
});
test('list and detail generations remain independent and closed or revoked details stay empty',async()=>{
 const m=new ReplayWorkspace(now);let release!:(v:any)=>void;const pending=m.open(()=>new Promise(ok=>release=ok),()=> 'actor','report-a');m.close();release({reportId:'report-a',bodyVerified:true});await pending;assert.equal(m.detail,null);
 const list=m.loadList(()=>new Promise(ok=>release=ok),()=> 'actor');m.clear('other',now);release({items:['old']});await list;assert.equal(m.list,null);assert.equal(m.detail,null);await assert.rejects(m.open(async()=>({reportId:'wrong',bodyVerified:true}),()=> 'actor','right'));assert.equal(m.detail,null);
});
test('history view escapes user and server strings, never displays an unverified old report, and disables busy fields',()=>{
 const m=new ReplayWorkspace(now);m.setFilters({...query,deviceCode:'<img onerror=bad>'});m.error='<script>bad</script>';const html=coverageReplayView(m,()=>true,'actor',true,true);assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(html.includes('资料截止'));assert.ok(html.includes('name="deviceCode"'));assert.ok(html.includes('disabled'));assert.ok(!html.includes('导出完整重算包'));
});
