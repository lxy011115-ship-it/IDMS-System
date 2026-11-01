const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'暂无';
const names={vibration_rms:'振动 RMS',bearing_temperature:'轴承温度',motor_current_std:'电流波动'};
export function telemetryView(data,points,updatedAt,canAnalyze=false){
  if(!data)return '<div class="empty">正在读取采集状态…</div>';
  const sources=data.sources||[];
  return `<section class="upload-hero"><div><span class="eyebrow">READ-ONLY TELEMETRY</span><h2>设备采集与数据质量</h2><p>原始采样时间、接收时间与质量分别保留。平台事务提交后，边缘才清理缓存。<br>本机模拟器不代表企业现场设备；没有 PLC 控制功能。</p></div><div class="api-mark"><code>${data.enabled?(data.brokerConnected&&data.subscribed?'MQTT 已连接':'MQTT 未就绪'):'未启用采集'}</code><span>${esc(updatedAt?time(updatedAt):'等待刷新')}</span></div></section>
  <div class="manual-demo-bar"><span>PostgreSQL 规范化遥测表 · TimescaleDB 尚未启用</span><div>OPC UA 只读 → SQLite → MQTT → SQL＋审计 → 签名确认</div></div>
  ${!sources.length?`<section class="panel"><div class="empty-small">${data.enabled?'当前企业没有授权采集源；不会展示其他企业的设备。':'当前运行方式未配置设备采集，手动上传仍可使用。'}</div></section>`:''}
  ${sources.map(source=>{
    const edge=source.edge,age=source.freshness==='FRESH'?'数据新鲜':source.freshness==='STALE'?'数据已过期':'尚无数据';
    return `<section class="panel telemetry-source"><div class="panel-head"><div><h2>${esc(source.deviceCode)} <span class="badge">${source.origin==='SIMULATOR'?'明确标识：模拟设备':'现场设备'}</span></h2><p>${esc(source.edgeId)} · 映射 ${esc(source.mapVersion)} · ${age}</p></div><span class="badge">${edge?.opcConnected?'OPC UA 已连接':'OPC UA 未确认'}</span></div><div class="upload-metrics">
    ${[['已存测点',source.total,'GOOD '+source.good+' / 低质量 '+source.low_quality],['待确认缓存',edge?.pending??'未知','平台已确认 '+(edge?.acknowledged??'未知')],['拒绝回执',source.rejections,'边缘待处置 '+(edge?.spoolVersion===2?(edge.records??'未知'):(edge?.rejected??'未知'))],['采样缺口',edge?.gaps??'未知','容量耗尽或采集失败时明确报告']].map(([label,value,note])=>`<article><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`).join('')}</div>
    ${edge?.spoolVersion===2&&edge.records>0?'<p class="boundary-note">拒绝消息及原始确认凭证已保全，仍需按维护流程处置；隔离不代表恢复正常。</p>':''}
    <p class="boundary-note">最新采样：${time(source.last_event_time)}　最新接收：${time(source.last_received_at)}。连接正常不代表数据新鲜，缓存补传可能是历史数据。</p>
    ${canAnalyze?`<button class="primary" data-action="telemetry-analyze" data-edge-id="${esc(source.edgeId)}">分析已入库采集窗口</button><p class="boundary-note">需三个测点各≥6条GOOD样本、覆盖≥5分钟且最新数据有效。仅工程规则，不提供故障概率或RUL。</p>`:''}
    ${edge?.lastError?`<div class="error-banner">边缘状态：${esc(edge.lastError)}</div>`:''}
    <div class="table-wrap"><table><thead><tr><th>测点</th><th>最近观测</th><th>质量</th><th>采样时间</th><th>接收时间</th></tr></thead><tbody>${source.latest.map(p=>`<tr><td>${esc(names[p.tag_code]||p.tag_code)}</td><td>${p.value===null?'无有效数值':esc(p.value)+' '+esc(p.unit)}</td><td><span class="badge">${esc(p.quality)}</span></td><td>${time(p.event_time)}</td><td>${time(p.received_at)}</td></tr>`).join('')||'<tr><td colspan="5">尚未收到观测记录</td></tr>'}</tbody></table></div></section>`;
  }).join('')}
  ${points?.length?`<section class="panel"><div class="panel-head"><div><h2>最近接收记录与血缘</h2><p>最多100条 · 原始质量保留 · BAD/UNCERTAIN 不进入健康分析</p></div></div><div class="table-wrap"><table><thead><tr><th>设备 / 测点</th><th>值 / 质量</th><th>采样 / 接收</th><th>序号 / 输入摘要</th></tr></thead><tbody>${points.map(p=>`<tr><td>${esc(p.device_code)}<span>${esc(names[p.tag_code]||p.tag_code)}</span></td><td>${p.value===null?'—':esc(p.value)} ${esc(p.unit)}<span>${esc(p.quality)}</span></td><td>${time(p.event_time)}<span>${time(p.received_at)}</span></td><td>${esc(p.sequence_no)}<span title="${esc(p.input_digest)}"><code>${esc(p.input_digest.slice(0,18))}…</code></span></td></tr>`).join('')}</tbody></table></div></section>`:''}
  <section class="panel"><div class="panel-head"><div><h2>当前验收边界</h2><p>工程开发验证，不是现场验收或故障预测精度证明</p></div></div><p class="boundary-note">已实现只读轮询、持久化缓存、受限主题、消息验签、事务确认和补传。真实设备证书与点表、订阅采集、边缘远程升级、容量规划、TimescaleDB 与生产运维仍待建设。可手动分析采集窗口，自动分析调度尚未实现；手动上传分析继续保留。</p></section>`;
}
