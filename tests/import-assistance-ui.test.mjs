import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadTypeGuide,batchNextStep,batchNextStepView,ImportErrorReview,importErrorView,errorAdvice} from '../public/import-assistance-ui.js';
const batch=(status='VALIDATION_FAILED',extra={})=>({batchId:'b1',uploader:'uploader',snapshotDigest:'a'.repeat(64),version:1,status,dataType:'DEVICE',counts:{invalid:2},errors:[],...extra});
const errors=[{row:58,field:'unit',sourceField:'单位',code:'UNIT_MISMATCH',message:'单位必须是MPa'},{row:58,field:'tag_code',sourceField:'测点',code:'UNKNOWN_TAG',message:'请先批准测点定义'},{row:103,field:'unit',sourceField:'单位',code:'REQUIRED',message:'必填字段为空'}];

test('all seven template guides explain prerequisites and use examples without auto-creation',()=>{
 for(const type of ['DEVICE','POINT_DEFINITION','MEASUREMENT','PRODUCTION','STATE_INTERVAL','MAINTENANCE','QUALITY']){
  const html=uploadTypeGuide(type);assert.match(html,/当前模板填写提示/);assert.match(html,/示例仅用于理解填法/);assert.match(html,/10,000/);
 }
 assert.match(uploadTypeGuide('MEASUREMENT'),/先批准设备及自定义测点定义/);
 assert.match(uploadTypeGuide('MAINTENANCE'),/不替代维修工单/);
 assert.equal(uploadTypeGuide('constructor'),'');assert.equal(uploadTypeGuide('UNKNOWN'),'');
});

test('next step distinguishes processing, validation, final approval and business queries',()=>{
 const expected={AI_PENDING:'refresh',VALIDATION_FAILED:'import-errors',HUMAN_REVIEW:'import-review',AWAITING_APPROVAL:'import-review',COMMITTED:'data-center',RETURNED:'import-decision',REJECTED:'import-decision'};
 for(const [status,action] of Object.entries(expected))assert.equal(batchNextStep(batch(status)).action,action);
 assert.equal(batchNextStep(batch('COMMITTED',{dataType:'PRODUCTION'})).action,'overview');
 assert.match(batchNextStep(batch('AI_PENDING')).detail,/尚未入库/);
 assert.match(batchNextStep(batch('unexpected')).detail,/未知状态/);
 assert.equal(batchNextStep(batch('unexpected')).stage,null);
});

test('uploader cannot be instructed to self-approve even with approver permission',()=>{
 for(const status of ['HUMAN_REVIEW','AWAITING_APPROVAL']){
  const own=batchNextStep(batch(status),{actor:'uploader',canApprove:true});
  assert.match(own.detail,/不能自审/);assert.match(own.title,/独立/);
  const reviewer=batchNextStep(batch(status),{actor:'reviewer',canApprove:true});
  assert.match(reviewer.title,status==='HUMAN_REVIEW'?/填写人工复核依据/:/核对材料并终审/);
  const reader=batchNextStep(batch(status),{actor:'auditor',canApprove:false});assert.match(reader.title,/独立/);
 }
 const html=batchNextStepView(batch('HUMAN_REVIEW'),{actor:'uploader',canApprove:true,busy:true});
 assert.match(html,/aria-current="step"/);assert.match(html,/disabled/);
 assert.doesNotMatch(html,/data-action="(?:decide|logout|sample)"/);
});

test('error filtering combines standard field and case-insensitive source/code/row search',()=>{
 const review=new ImportErrorReview();review.bind(batch(),'actor');
 review.query='58';assert.deepEqual(review.filter(errors),errors.slice(0,2));
 review.field='unit';assert.deepEqual(review.filter(errors),[errors[0]]);
 review.query='required';assert.deepEqual(review.filter(errors),[errors[2]]);
 review.field='';review.query='测点';assert.deepEqual(review.filter(errors),[errors[1]]);
});

test('filter is retained for the same binding and cleared for batch, version, snapshot or identity changes',()=>{
 const review=new ImportErrorReview(),base=batch();review.bind(base,'actor');review.query='secret';review.field='unit';
 review.bind(base,'actor');assert.equal(review.query,'secret');
 for(const [next,identity] of [[{...base,batchId:'b2'},'actor'],[{...base,version:2},'actor'],[{...base,snapshotDigest:'b'.repeat(64)},'actor'],[base,'other-actor'],[null,'other-actor']]){
  review.bind(next,identity);assert.equal(review.field,'');assert.equal(review.query,'');review.query='secret';review.field='unit';
 }
});

test('error display distinguishes bad row count, loaded entries, physical rows and full download',()=>{
 const review=new ImportErrorReview(),b=batch('VALIDATION_FAILED',{errors});
 const html=importErrorView(review,b,{unit:'单位'});
 assert.match(html,/2行校验未通过/);assert.match(html,/前3条错误/);assert.match(html,/同一行可能有多个错误/);
 assert.match(html,/第58行/);assert.match(html,/原表头：单位/);assert.match(html,/UNIT_MISMATCH/);
 assert.match(html,/下载完整错误CSV/);assert.match(html,/不是预览页码/);assert.match(html,/不会自动换算/);
 review.query='no-match';assert.match(importErrorView(review,b,{}),/下载完整CSV核对其余错误/);
 assert.equal(importErrorView(review,batch(),{}),'');
});

test('untrusted error text, fields, source headers and filter values cannot inject markup',()=>{
 const attack='<img src=x onerror=alert(1)>',review=new ImportErrorReview();review.query=attack;review.field=attack;
 const b=batch('VALIDATION_FAILED',{errors:[{row:58,field:attack,sourceField:attack,code:attack,message:attack}]});
 const html=importErrorView(review,b,{[attack]:attack});
 assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;img/);
 assert.match(errorAdvice('constructor'),/对照模板/);assert.match(errorAdvice('__proto__'),/对照模板/);
});
