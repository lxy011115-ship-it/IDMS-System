import test from 'node:test';
import assert from 'node:assert/strict';
import {workbenchSummary,businessFreshness,workspaceIcon,scenarioNotice} from '../public/roadshow-ui.js';
test('workbench distinguishes personal corrections from independent approval and uninitialized stock',()=>{
 const batches=[{uploader:'me',status:'VALIDATION_FAILED'},{uploader:'other',status:'VALIDATION_FAILED'},{uploader:'me',status:'AWAITING_APPROVAL'},{uploader:'other',status:'HUMAN_REVIEW'}];const html=workbenchSummary({batches,actor:'me',canApprove:true,name:'<admin>'});assert.match(html,/&lt;admin&gt;/);assert.doesNotMatch(html,/<admin>/);assert.match(html,/可独立复核的批次/);assert.equal((html.match(/<strong>1<\/strong>/g)||[]).length,2);assert.match(html,/<strong>—<\/strong>/);assert.match(html,/备件资料尚未读取/);
});
test('source information states no freshness rule and does not imply live device health',()=>{
 const html=businessFreshness({dataAsOf:'2026-10-01T00:00:00Z'});assert.match(html,/未配置/);assert.match(html,/不代表设备实时在线/);assert.doesNotMatch(html,/status-dot/);assert.match(scenarioNotice(),/含预置场景/);assert.match(scenarioNotice(),/RUL尚未评估/);assert.match(workspaceIcon('home'),/<svg/);
});
