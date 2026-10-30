import test from 'node:test';
import assert from 'node:assert/strict';
import {businessDay} from '../server/spares.ts';
import {sparesView,installSparesUi} from '../public/spares-ui.js';
import {workspaceGroups,workspaceNavigation,workspaceTabs,canonicalView} from '../public/workspace-navigation.js';
const data={available:true,revision:'1',publicRevision:'1',capabilities:{manage:true,request:true,move:true,finance:true},summary:{low:0,pending:0,overdue:0,replacementDue:0,financeReview:0},activeCounts:{part:0,supplier:0,warehouse:0}};
test('six groups preserve the old views and map duplicate device entry',()=>{
 assert.equal(workspaceGroups.length,6);const ids=workspaceGroups.flatMap(g=>g.views);assert.equal(new Set(ids).size,ids.length);assert.equal(canonicalView('devices'),'data-center');
 const nav=ids.map(id=>[id,'',id]);assert.equal((workspaceNavigation(nav,'spares').match(/<button /g)||[]).length,6);assert.match(workspaceTabs(nav,'quality-policy'),/aria-current="page"[^>]*>quality-policy/);assert.equal(workspaceTabs(nav,'devices'),'');assert.match(workspaceTabs(nav,'source-governance'),/接入配置分类/);assert.match(workspaceTabs(nav,'operational'),/报告中心分类/);
});
test('all inventory tabs and command editors render using page data and escape input',async()=>{
 const state={view:'spares',spares:{data,pages:{},tab:'inventory'}},s=state.spares,ui=installSparesUi({state,api:async()=>data,post:()=>{},render:()=>{},notify:()=>{}});
 for(const tab of ['inventory','parts','suppliers','purchases','movements','links','adjustments','documents']){s.tab=tab;assert.match(sparesView(s,'clerk'),/备件采购页签/);}
 for(const action of ['part.create','supplier.create','warehouse.create','purchase.create','stock.issue','stock.transfer','adjustment.create','link.create']){await ui.openEditor(action,'','填写');assert.match(sparesView(s),/id="spares-form"/);}
 s.editor={action:'stock.return',values:{quantity:'2',reason:'<script>alert(1)</script>'},id:'m',fields:{},selected:{}};assert.match(sparesView(s),/value="&lt;script&gt;/);assert.doesNotMatch(sparesView(s),/<script>alert/);
});
test('business dates use China local date at UTC midnight boundary',()=>{
 assert.equal(businessDay(new Date('2026-10-29T16:01:00Z')),'2026-10-30');assert.equal(businessDay(new Date('2026-10-29T15:59:00Z')),'2026-10-29');
});
test('first-use guidance uses complete active counts and respects role capabilities',()=>{
 const s={data,tab:'inventory',pages:{}};assert.match(sparesView(s),/建立档案/);s.data={...data,capabilities:{manage:false,request:true}};const html=sparesView(s);assert.match(html,/请由备件管理员/);assert.doesNotMatch(html,/data-command="(?:part|supplier|warehouse)\.create"/);
 s.data={...data,activeCounts:{part:10001,supplier:1,warehouse:1}};assert.doesNotMatch(sparesView(s),/首次使用/);
});
