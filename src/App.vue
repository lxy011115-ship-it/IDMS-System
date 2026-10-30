<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Activity, AlarmClock, Boxes, BrainCircuit, CheckCircle2, ChevronDown, CircleUserRound, ClipboardCheck, FileStack, Gauge, History, LayoutDashboard, Network, Plug, RefreshCw, Search, Settings, ShieldCheck, Wrench, X } from "lucide-vue-next";
import { get, post } from "./api";
import type { Alarm, Audit, Device, Overview } from "./types";

type View = "overview"|"devices"|"alarms"|"approvals"|"templates"|"plugins"|"audit";
const view = ref<View>("overview"), overview = ref<Overview|null>(null), audits = ref<Audit[]>([]), chainValid = ref(true), loading = ref(true), error = ref("");
const selected = ref<Alarm|null>(null), approveOpen = ref(false), comment = ref(""), busy = ref(false), toast = ref("");
const nav = [
  {label:"运营总览",id:"overview",icon:LayoutDashboard},{label:"设备监控",id:"devices",icon:Gauge},{label:"报警中心",id:"alarms",icon:AlarmClock},
  {label:"人工终审",id:"approvals",icon:ClipboardCheck},{label:"模板中心",id:"templates",icon:FileStack},{label:"插件中心",id:"plugins",icon:Plug},{label:"追溯审计",id:"audit",icon:History}
] as const;
const title = computed(()=>nav.find(n=>n.id===view.value)?.label||"");
const devices = computed(()=>overview.value?.devices||[]), alarms = computed(()=>overview.value?.alarms||[]);
const pending = computed(()=>alarms.value.filter(a=>a.state==="AWAITING_APPROVAL"));
const stateMap:Record<string,string>={RUNNING:"运行",IDLE:"待机",DOWN:"停机",ALARM:"报警",OFFLINE:"离线",OPEN:"待确认",ACKNOWLEDGED:"已确认",ASSIGNED:"已派单",REPAIRING:"维修中",AWAITING_APPROVAL:"待终审",CLOSED:"已关闭"};
const severityMap:Record<string,string>={LOW:"低",MEDIUM:"中",HIGH:"高",CRITICAL:"紧急"};
function flash(msg:string){toast.value=msg;setTimeout(()=>toast.value="",2600)}
async function load(){ loading.value=true; error.value=""; try{ overview.value=await get<Overview>("/overview"); if(view.value==="audit"){const r=await get<{items:Audit[];chainValid:boolean}>("/audit");audits.value=r.items;chainValid.value=r.chainValid} }catch(e){error.value=e instanceof Error?e.message:"加载失败"}finally{loading.value=false} }
async function aiReview(a:Alarm){busy.value=true;try{selected.value=await post<Alarm>(`/alarms/${a.id}/ai-review`,{});await load();flash("AI 审核完成，结果已写入追溯链")}catch(e){flash(e instanceof Error?e.message:"审核失败")}finally{busy.value=false}}
async function approve(decision:"APPROVED"|"REJECTED"|"RETURNED"){if(!selected.value||!comment.value.trim())return;busy.value=true;try{await post(`/alarms/${selected.value.id}/approval`,{decision,comment:comment.value});approveOpen.value=false;selected.value=null;comment.value="";await load();flash(decision==="APPROVED"?"人工终审通过，报警已关闭":"处理结果已退回")}catch(e){flash(e instanceof Error?e.message:"审批失败")}finally{busy.value=false}}
function switchView(v:View){view.value=v;selected.value=null;load()}
onMounted(load);
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark"><Activity :size="20"/></div><div><strong>IDMS</strong><span>智能设备管理平台</span></div></div>
      <div class="tenant"><span class="tenant-logo">华</span><div><b>{{overview?.tenant.name||"华东精工"}}</b><small>企业版 · 生产环境</small></div><ChevronDown :size="15"/></div>
      <nav><button v-for="item in nav" :key="item.id" :class="{active:view===item.id}" @click="switchView(item.id)"><component :is="item.icon" :size="18"/><span>{{item.label}}</span><em v-if="item.id==='approvals'&&pending.length">{{pending.length}}</em></button></nav>
      <div class="nav-section">系统</div>
      <nav><button><Network :size="18"/><span>集成接口</span></button><button><Settings :size="18"/><span>系统配置</span></button></nav>
      <div class="sidebar-foot"><ShieldCheck :size="16"/><span>审计链运行正常</span></div>
    </aside>
    <main>
      <header><div><h1>{{title}}</h1><p>离散制造标准模板 · 数据更新于 {{new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}}</p></div><div class="head-actions"><button class="icon-btn" title="刷新" @click="load"><RefreshCw :size="17"/></button><div class="search"><Search :size="16"/><span>搜索设备、报警或工单</span><kbd>⌘ K</kbd></div><CircleUserRound :size="29"/></div></header>
      <section class="content">
        <div v-if="loading" class="empty">正在同步运营数据...</div><div v-else-if="error" class="empty error">{{error}}</div>
        <template v-else-if="overview">
          <template v-if="view==='overview'">
            <div class="alert-strip"><BrainCircuit :size="18"/><div><b>AI 运行摘要</b><span>当前有 {{pending.length}} 项等待人工终审；其余中间审核均已自动完成。</span></div><button @click="switchView('approvals')">进入终审队列</button></div>
            <div class="metrics">
              <article><span>综合 OEE</span><b>{{overview.metrics.oee.toFixed(1)}}%</b><small class="up">较上班次 +2.4%</small></article>
              <article><span>设备运行</span><b>{{overview.metrics.running}}<i>/ {{overview.metrics.deviceCount}}</i></b><small>实时在线状态</small></article>
              <article><span>活动报警</span><b>{{overview.metrics.activeAlarms}}</b><small class="warn">含 1 项紧急报警</small></article>
              <article><span>平均 MTBF</span><b>{{overview.metrics.mtbf.toFixed(0)}}<i> h</i></b><small>目标值 160 h</small></article>
              <article><span>平均 MTTR</span><b>{{overview.metrics.mttr.toFixed(0)}}<i> min</i></b><small class="warn">高于目标 8 min</small></article>
            </div>
            <div class="grid-2">
              <section class="panel"><div class="panel-head"><div><h2>设备运行状态</h2><p>按产线查看关键设备即时状态</p></div><button class="text-btn" @click="switchView('devices')">查看全部</button></div><DeviceTable :items="devices.slice(0,4)" :state-map="stateMap"/></section>
              <section class="panel"><div class="panel-head"><div><h2>实时 OEE</h2><p>设备效率与目标值对比</p></div><span class="legend"><i></i> OEE</span></div><div class="bars"><div v-for="d in devices.slice(0,4)" :key="d.id"><label><span>{{d.code}}</span><b>{{d.oee}}%</b></label><div><i :style="{width:d.oee+'%'}" :class="{low:d.oee<75}"></i><em style="left:85%"></em></div></div></div></section>
            </div>
            <section class="panel"><div class="panel-head"><div><h2>报警与处置队列</h2><p>AI 自动分析后，关键关单由授权人员终审</p></div><button class="text-btn" @click="switchView('alarms')">进入报警中心</button></div><AlarmTable :items="alarms" :state-map="stateMap" :severity-map="severityMap" @select="selected=$event"/></section>
          </template>
          <template v-else-if="view==='devices'">
            <div class="toolbar"><div class="segmented"><button class="selected">全部设备</button><button>运行</button><button>报警</button><button>停机</button></div><button class="primary"><Boxes :size="16"/>导入设备</button></div>
            <section class="panel"><div class="panel-head"><div><h2>设备资产与运行指标</h2><p>只读采集 · 最近数据质量 99.4%</p></div><span class="pill ok">边缘节点在线</span></div><DeviceTable :items="devices" :state-map="stateMap" detailed/></section>
          </template>
          <template v-else-if="view==='alarms'||view==='approvals'">
            <div class="toolbar"><div class="segmented"><button :class="{selected:view==='alarms'}">全部报警</button><button :class="{selected:view==='approvals'}">待人工终审 {{pending.length}}</button></div><button class="secondary"><Wrench :size="16"/>报警规则</button></div>
            <section class="panel"><div class="panel-head"><div><h2>{{view==='approvals'?'人工终审队列':'报警处置中心'}}</h2><p>{{view==='approvals'?'AI 已完成证据整理，最终责任动作必须由人批准':'从产生、AI 分析、派单到人工关单的完整闭环'}}</p></div></div><AlarmTable :items="view==='approvals'?pending:alarms" :state-map="stateMap" :severity-map="severityMap" @select="selected=$event"/></section>
          </template>
          <template v-else-if="view==='templates'">
            <section class="panel hero-panel"><div><span class="eyebrow">已发布模板</span><h2>离散制造标准模板 <small>v1.2.0</small></h2><p>设备、报警、维护、质量四个模块已启用。企业差异通过字段、流程、规则和看板覆盖，无客户源码分支。</p><div class="template-tags"><span>设备管理</span><span>报警闭环</span><span>点检保养</span><span>质量 SPC</span></div></div><FileStack :size="72"/></section>
            <div class="grid-3"><article class="mini-card"><b>字段与表单</b><strong>34</strong><span>企业扩展字段 8 个</span></article><article class="mini-card"><b>流程定义</b><strong>6</strong><span>全部含人工终审门</span></article><article class="mini-card"><b>规则与指标</b><strong>18</strong><span>当前无待发布变更</span></article></div>
          </template>
          <template v-else-if="view==='plugins'">
            <section class="panel"><div class="panel-head"><div><h2>认证插件</h2><p>仅签名且通过厂商认证的插件可以进入租户运行环境</p></div><button class="primary"><Plug :size="16"/>提交插件</button></div><div class="plugin-row"><div class="plugin-icon"><Network/></div><div><b>OPC UA 只读适配器</b><span>device-adapter · v1.0.0</span></div><span class="pill ok"><CheckCircle2 :size="14"/>已签名并激活</span><code>telemetry:write · device:read</code></div></section>
          </template>
          <template v-else-if="view==='audit'">
            <div class="audit-status" :class="{bad:!chainValid}"><ShieldCheck :size="22"/><div><b>{{chainValid?'审计链校验通过':'审计链校验失败'}}</b><span>租户内事件采用追加式 SHA-256 哈希链，普通管理员不可修改</span></div></div>
            <section class="panel"><div class="panel-head"><div><h2>追溯事件</h2><p>业务、AI、规则、接口和人工审批统一时间线</p></div></div><div v-if="!audits.length" class="empty compact">完成一次 AI 审核或人工终审后，事件将在此显示。</div><div class="timeline"><article v-for="a in audits" :key="a.eventId"><span class="dot"></span><div><b>{{a.action}}</b><small>{{a.objectType}} · {{a.objectId}} · {{a.actorType}}/{{a.actorId}}</small><p>{{new Date(a.businessTime).toLocaleString('zh-CN')}}</p><code>{{a.hash.slice(0,22)}}...</code></div></article></div></section>
          </template>
        </template>
      </section>
    </main>
    <aside v-if="selected" class="drawer"><div class="drawer-head"><div><span class="eyebrow">{{selected.id}}</span><h2>{{selected.title}}</h2></div><button class="icon-btn" @click="selected=null"><X/></button></div><div class="drawer-body"><div class="definition"><span>当前状态</span><b><i class="status-dot" :class="selected.state"></i>{{stateMap[selected.state]}}</b><span>风险等级</span><b>{{severityMap[selected.severity]}}</b><span>负责人</span><b>{{selected.assignee||'未分配'}}</b></div><div v-if="selected.aiReview" class="ai-card"><div class="ai-title"><BrainCircuit :size="19"/><b>AI 审核结论</b><span>{{Math.round(selected.aiReview.confidence*100)}}% 置信度</span></div><p>{{selected.aiReview.conclusion}}</p><h3>证据</h3><ul><li v-for="e in selected.aiReview.evidence" :key="e">{{e}}</li></ul><h3>建议动作</h3><p>{{selected.aiReview.recommendedAction}}</p><small>模型版本 {{selected.aiReview.status}} · 全部输入输出已追溯</small></div><div v-else class="ai-empty"><BrainCircuit/><b>尚未执行 AI 审核</b><p>AI 将检索历史案例与企业知识，并给出结构化建议。</p><button class="primary" :disabled="busy" @click="aiReview(selected)">开始 AI 审核</button></div></div><div class="drawer-foot"><template v-if="selected.state==='AWAITING_APPROVAL'"><button class="secondary" @click="aiReview(selected)">重新审核</button><button class="primary" @click="approveOpen=true">人工终审</button></template><template v-else><button class="secondary" @click="selected=null">关闭</button><button class="primary" :disabled="busy" @click="aiReview(selected)">运行 AI 审核</button></template></div></aside>
    <div v-if="approveOpen" class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">最终责任动作</span><h2>人工终审</h2></div><button class="icon-btn" @click="approveOpen=false"><X/></button></div><p>批准后报警将正式关闭。该动作不可由 AI 自动执行，并会生成签名审批记录。</p><label>审批意见<textarea v-model="comment" placeholder="填写复测结果、判断依据和审批意见"></textarea></label><div class="modal-actions"><button class="danger" :disabled="busy||!comment.trim()" @click="approve('RETURNED')">退回处理</button><button class="primary" :disabled="busy||!comment.trim()" @click="approve('APPROVED')"><CheckCircle2 :size="16"/>批准并关单</button></div></div></div>
    <div v-if="toast" class="toast">{{toast}}</div>
  </div>
</template>

<script lang="ts">
import { defineComponent, h } from "vue";
export const DeviceTable=defineComponent({props:{items:{type:Array as()=>Device[],required:true},stateMap:{type:Object as()=>Record<string,string>,required:true},detailed:Boolean},setup(p){return()=>h('div',{class:'table-wrap'},[h('table',[h('thead',h('tr',[h('th','设备'),h('th','产线'),h('th','状态'),h('th','OEE'),...(p.detailed?[h('th','MTBF'),h('th','MTTR')]:[])])),h('tbody',p.items.map(d=>h('tr',{key:d.id},[h('td',[h('b',d.code),h('span',d.name)]),h('td',d.line),h('td',h('span',{class:`state ${d.status}`},[h('i'),p.stateMap[d.status]])),h('td',h('strong',{class:d.oee<70?'bad-text':''},`${d.oee}%`)),...(p.detailed?[h('td',`${d.mtbf} h`),h('td',`${d.mttr} min`)]:[])])))] )])}});
export const AlarmTable=defineComponent({emits:['select'],props:{items:{type:Array as()=>Alarm[],required:true},stateMap:{type:Object as()=>Record<string,string>,required:true},severityMap:{type:Object as()=>Record<string,string>,required:true}},setup(p,{emit}){return()=>h('div',{class:'table-wrap'},[h('table',[h('thead',h('tr',[h('th','报警'),h('th','风险'),h('th','状态'),h('th','AI 审核'),h('th','负责人'),h('th','')])),h('tbody',p.items.map(a=>h('tr',{key:a.id,onClick:()=>emit('select',a)},[h('td',[h('b',a.title),h('span',a.id)]),h('td',h('span',{class:`severity ${a.severity}`},p.severityMap[a.severity])),h('td',h('span',{class:`state ${a.state}`},[h('i'),p.stateMap[a.state]])),h('td',a.aiReview?h('span',{class:'ai-done'},`已完成 · ${Math.round(a.aiReview.confidence*100)}%`):h('span',{class:'muted'},'待执行')),h('td',a.assignee||'—'),h('td',h('button',{class:'row-action'},'查看'))])))] )])}});
</script>
