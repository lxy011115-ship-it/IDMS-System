const $=id=>document.getElementById(id);let csrf='',currentView=null,identity=null;
async function api(path,options){const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});const value=await response.json();if(!response.ok)throw Error(value.message||'维护入口暂不可用，请联系恢复操作负责人。');return value;}
function message(text,error=false){$('message').textContent=text;$('message').className=error?'error':'';}
function details(element,items){element.replaceChildren();for(const [label,value]of items){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=String(value);element.append(dt,dd);}}
function references(element,refs,empty){const rows=refs.map(r=>{const li=document.createElement('li');li.textContent=[r.templateKey||r.id,r.version,r.contentDigest,r.digestKind==='LEGACY_BODY_SHA256'?'历史正文摘要':r.digestKind==='DECLARED'?'声明摘要':null].filter(Boolean).join(' · ');return li;});if(!rows.length){const li=document.createElement('li');li.textContent=empty;rows.push(li);}element.replaceChildren(...rows);}
function showPlan(v){
 currentView=v;const p=v.recoveryPlan;$('plan-panel').hidden=!p;const roles=identity?.roles||[],author=v.reviewActionsAvailable&&!roles.includes('system-admin')&&roles.includes('tenant-admin'),reviewer=v.reviewActionsAvailable&&!roles.includes('system-admin')&&roles.includes('final-approver')&&v.reviewStage==='SUBMITTED'&&p&&!p.contributors.includes(identity.actorId)&&Date.now()<Date.parse(p.expiresAt);$('submit-plan').hidden=!author;$('submit-plan').textContent=p?'提交替换计划':'提交恢复计划';$('approve-plan').hidden=!reviewer;$('review-actions').hidden=!(author||reviewer);$('review-confirm').checked=false;$('review-action-help').textContent=reviewer?'批准前将重新核对你与作者的当前权限，以及当前工作流状态。':'提交时将绑定当前目标、完整数据摘要和策略引用，并重新核对你的当前权限。';
 $('review-state').textContent='当前外部状态：'+(v.currentExternalState==='RECHECK_REQUIRED'?'需重新核对':'待检查')+'　·　独立审批：'+(v.independentApproval==='RECORDED'?'已记录（激活前仍需复核）':'待完成');
 const registration=p?.registration;$('registration-panel').hidden=!registration;if(registration){details($('registration-summary'),[['注册摘要',registration.registrySha256],['配置材料摘要',registration.configSha256],['签发公钥标识',registration.registry.leaseKeyId],['恢复操作',registration.operationId]]);$('registration-channels').replaceChildren(...registration.registry.channels.map(channel=>{const item=document.createElement('details'),title=document.createElement('summary'),body=document.createElement('pre');title.textContent=channel.profile.source.edgeId+' · '+channel.profile.source.deviceCode+' · '+channel.profile.source.mapVersion;body.textContent=JSON.stringify(channel,null,2);item.append(title,body);return item;}));}
 if(!p)return;
 const expired=Date.now()>=Date.parse(p.expiresAt);
 details($('plan-summary'),[['计划',p.planId],['计划摘要',p.planSha256],['阶段',v.reviewStage==='APPROVED'?'已批准':v.reviewStage==='SUBMITTED'?'已提交':'待提交'],['作者',p.authorId],['参与作者',p.contributors.join('、')],['计划有效期',new Date(p.expiresAt).toLocaleString()+(expired?'（已过期，须重新提交）':'')],['独立审批人',p.approval?.actorId||'待审批'],['审批记录时间',p.approval?new Date(p.approval.recordedAt).toLocaleString():'—'],['待启用部署标识',p.identity.deploymentId],['待启用激活标识',p.identity.activationId],['工作流核对摘要',p.workflowSha256]]);
 references($('plan-references'),p.policyReferences,'本计划无已发布策略引用');
}
async function refresh(){
 const button=$('refresh');button.disabled=true;$('result').hidden=true;message('正在核对数据和恢复围栏…');
 try{
  const v=await api('/api/v1/recovery/status');
  details($('summary'),[['企业',v.tenantId],['恢复操作',v.operationId],['备份',v.backupId],['目标库',v.targetDatabase],['业务版本',v.verified.revision],['数据摘要',v.verified.factsSha256],['结构摘要',v.verified.catalogSha256],['本次核对',new Date(v.evaluatedAt).toLocaleString()],['维护有效期',new Date(v.expiresAt).toLocaleString()]]);
  $('relations').replaceChildren(...v.relations.map(r=>{const tr=document.createElement('tr');for(const value of [r.schema+'.'+r.table,r.rows]){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}return tr;}));
  references($('references'),v.historicalPublishedReferences,'无历史已发布引用');showPlan(v);$('result').hidden=false;message('本次只读核对通过，业务写入和现场接入仍保持关闭。');
 }catch(e){message(e.message,true);}finally{button.disabled=false;}
}
$('refresh').addEventListener('click',refresh);
$('logout').addEventListener('click',async()=>{try{await api('/api/v1/auth/logout',{method:'POST',headers:{'X-CSRF-Token':csrf}});location.replace('/');}catch(e){message(e.message,true);}});
(async()=>{try{const session=await api('/api/v1/auth/session');$('login-panel').hidden=session.authenticated;$('logout').hidden=!session.authenticated;if(session.authenticated){csrf=session.csrfToken;identity=session.user;await refresh();}else message('登录后可查看本次恢复核对结果。');}catch(e){message(e.message,true);}})();

async function reviewAction(action){
 if(!currentView||!$('review-confirm').checked){message('请先核对计划并勾选确认。',true);return;}
 $('submit-plan').disabled=true;$('approve-plan').disabled=true;$('refresh').disabled=true;message('正在重新核对当前权限和工作流，并记录恢复审批…');
 try{
  const p=currentView.recoveryPlan,body={action,planId:action==='SUBMIT'?crypto.randomUUID():p.planId,expectedFactsSha256:currentView.verified.factsSha256,...(action==='SUBMIT'&&p?{supersedesPlanId:p.planId}:{})},response=await fetch('/api/v1/recovery/review',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)}),reply=await response.json();
  if(reply.rotation){$('result').hidden=true;$('logout').hidden=true;$('login-panel').hidden=false;message(reply.ok?'操作已记录。维护锚点正在更换，请稍后重新登录核对。':'维护状态已变化，请重新登录核对实际结果。',!reply.ok);return;}
  if(!response.ok)throw Error(reply.message||'恢复审批条件尚未满足');await refresh();
 }catch(e){message(e.message||'恢复入口已变化，请重新登录核对。',true);}finally{$('submit-plan').disabled=false;$('approve-plan').disabled=false;$('refresh').disabled=false;}
}
$('submit-plan').addEventListener('click',()=>reviewAction('SUBMIT'));
$('approve-plan').addEventListener('click',()=>reviewAction('APPROVE'));
