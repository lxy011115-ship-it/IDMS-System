import test from 'node:test';
import assert from 'node:assert/strict';
import {sparesHistoryView,emptyHistory} from '../public/spares-history-ui.js';
import {installSparesUi,sparesView} from '../public/spares-ui.js';
const page=(sequence='3',next='2')=>({available:true,items:[{sequence,actionLabel:'<操作>',actorId:'<actor>',siteCode:'F1',at:'2026-10-29T12:00:00Z',changes:[{id:'id',label:'<备件>',changeType:'UPDATE',fields:[{label:'名称',before:'<old>',after:'<new>'}]}]}],hasMore:!!next,nextBefore:next,actionLabels:{'part.update':'修改备件'},notice:'已核验'});
test('history renders escaped summaries and remains independent from the legacy full-state response',()=>{
 const h=emptyHistory();h.data=page();const html=sparesHistoryView(h);assert.match(html,/&lt;actor&gt;/);assert.match(html,/&lt;new&gt;/);assert.doesNotMatch(html,/<actor>|<new>/);assert.match(sparesView({tab:'history',history:h,data:null}),/备件操作历史/);
});
test('history paging sends anchors, returns to newer page and discards a late result after identity clear',async()=>{
 const state={view:'spares',spares:{tab:'history',history:emptyHistory()}},calls=[];let finish;const ui=installSparesUi({state,api:async url=>{calls.push(url);if(calls.length===4)return new Promise(r=>finish=r);return page();},post:()=>{},render:()=>{},notify:()=>{}});
 await ui.load();await ui.handle({dataset:{action:'spares-history-older'}});assert.match(calls[1],/before=2/);await ui.handle({dataset:{action:'spares-history-newer'}});assert.doesNotMatch(calls[2],/before=/);const pending=ui.load();ui.clear();finish(page());await pending;assert.equal(state.spares.history.data,null);
});
test('editing filters while on an older page resets the anchor before the next query',async()=>{
 const state={view:'spares',spares:{tab:'history',history:emptyHistory()}},calls=[],ui=installSparesUi({state,api:async url=>{calls.push(url);return page();},post:()=>{},render:()=>{},notify:()=>{}});await ui.load();await ui.handle({dataset:{action:'spares-history-older'}});state.spares.history.filters.q='BRG';await ui.handle({dataset:{action:'spares-history-refresh'}});assert.match(calls[2],/q=BRG/);assert.doesNotMatch(calls[2],/before=/);assert.deepEqual(state.spares.history.stack,[]);
});

test('direct history entry loads inventory when switching back to a business tab',async()=>{
 const stamp={revision:'1',publicRevision:'1'},state={view:'spares',spares:{tab:'history',history:emptyHistory()}},calls=[],ui=installSparesUi({state,api:async url=>{calls.push(url);return url.includes('/history')?page():url==='/spares/summary'?{available:true,...stamp,summary:{},activeCounts:{},capabilities:{}}:{available:true,...stamp,items:[],hasMore:false,nextCursor:null};},post:()=>{},render:()=>{},notify:()=>{}});await ui.load();await ui.handle({dataset:{action:'spares-tab',tab:'inventory'}});assert.ok(calls.includes('/spares/summary'));assert.match(calls.at(-1),/^\/spares\/list\?kind=warehouse/);assert.ok(!calls.includes('/spares'));assert.equal(state.spares.data.available,true);
});

test('stale history cursor clears page stack and explicit reread returns to latest page',async()=>{
 const state={view:'spares',spares:{tab:'history',history:emptyHistory()}},calls=[];
 const ui=installSparesUi({state,api:async url=>{calls.push(url);if(calls.length===2)throw Object.assign(Error('业务资料已变化，请从最新一页查询'),{status:409});return page('3','signed.opaque_token');},post:()=>{},render:()=>{},notify:()=>{}});
 await ui.load();await ui.handle({dataset:{action:'spares-history-older'}});assert.match(calls[1],/before=signed/);assert.equal(state.spares.history.before,'');assert.deepEqual(state.spares.history.stack,[]);assert.equal(state.spares.history.data,null);assert.match(state.spares.history.error,/已变化/);
 await ui.handle({dataset:{action:'spares-history-refresh'}});assert.doesNotMatch(calls[2],/before=/);assert.ok(state.spares.history.data);
});
