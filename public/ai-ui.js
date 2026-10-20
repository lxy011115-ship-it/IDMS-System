export function enhanceAiReviewUi(state,root){
  const configured=state.integrations?.items?.find(i=>i.id==='ai')?.mode?.includes('SHADOW');
  if(state.auth.mode==='oidc'){
    state.aiMode=configured?'gateway':'unavailable';
    const select=root.querySelector('#ai-mode');
    if(select){select.replaceChildren(new Option(configured?'本地真实模型 · 影子审阅后人工复核':'真实模型未配置 · 人工复核',state.aiMode));select.disabled=true;}
    const banner=root.querySelector('.manual-demo-bar > span');
    if(banner)banner.textContent=configured?'DEV · 真实身份与企业数据库 · 本地模型影子审核 · 最终批准由独立人员完成':'DEV · 真实身份与企业数据库 · 模型未配置时人工复核';
    if(['uploads','approvals'].includes(state.view))for(const p of root.querySelectorAll('.approval-notice p'))p.textContent='AI不能批准入库。影子审核结果必须人工核实；上传者不能批准本人的批次。转人工批次需填写复核依据。';
    for(const p of root.querySelectorAll('p'))if(p.textContent.includes('上传AI审核仍为模拟'))p.textContent='真实OIDC、企业数据库和Flowable以集成页面实际状态为准。配置本地模型网关后，新上传使用真实影子审阅；旧演示批次保留原始标记。工程规则不是故障概率或RUL，现场与生产验收仍未完成。';
  }
  const b=state.selected,g=b?.aiReview.gateway;
  if(!g)return;
  const card=root.querySelector('.import-drawer .ai-card');if(!card)return;
  card.dataset.testid='real-ai-review';
  card.querySelector('.ai-title b').textContent=b.status==='AI_PENDING'?'本地真实AI处理中':g.receipt?.provenance==='LOCAL_MODEL'?'真实模型影子审阅':'AI失败关闭／策略复核';
  card.querySelector('.ai-title span').textContent='SHADOW · 非生产自动审核 · 无校准置信度';
  const facts=document.createElement('dl');facts.className='batch-facts ai-audit-meta';
  const fields=[['请求ID',g.requestId],['请求摘要',g.requestDigest],['固定模型摘要',g.modelDigest],['提示／策略',g.promptVersion+' / '+g.policyVersion],['语义审阅范围',`${g.sampledRows}/${g.totalRows} 行摘要；不宣称全量正确`]];
  if(g.receipt)fields.push(['回执ID',g.receipt.receiptId],['回执来源',g.receipt.provenance],['复核原因',g.receipt.reason],['完成时间',g.receipt.completedAt],['推理用量',g.receipt.usage?`${g.receipt.usage.inputTokens} 输入 / ${g.receipt.usage.outputTokens} 输出 token`:'未执行有效推理']);
  for(const [label,value] of fields){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;facts.append(dt,dd);}
  card.append(facts);
}
