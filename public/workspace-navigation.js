import {workspaceIcon} from './roadshow-ui.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const workspaceGroups=[
 {id:'home',label:'工作台',icon:'▦',views:['overview','approvals']},
 {id:'equipment',label:'设备中心',icon:'◉',views:['data-center']},
 {id:'spares',label:'备件与采购',icon:'▤',views:['spares']},
 {id:'operations',label:'运维中心',icon:'⚒',views:['predictive','work-orders','telemetry']},
 {id:'data',label:'数据与报表',icon:'⇧',views:['uploads','data-quality','quality-policy','analysis','coverage-history','operational']},
 {id:'settings',label:'系统管理',icon:'⚙',views:['templates','equipment-profiles','roles','integrations','source-governance','field-channels','audit','guide']}
];
export const canonicalView=view=>view==='devices'?'data-center':view;
export function workspaceNavigation(navigation,current,pending=0){const view=canonicalView(current);return workspaceGroups.map(g=>{const members=g.views.filter(v=>navigation.some(n=>n[0]===v));if(!members.length)return '';return `<button data-action="nav" data-view="${members[0]}" class="${members.includes(view)?'active':''}" title="${g.label}"><b>${workspaceIcon(g.id)}</b><span>${g.label}</span>${g.id==='home'&&pending?`<em>${esc(pending)}</em>`:''}</button>`;}).join('');}
const clusters=[{label:'报告中心',views:['coverage-history','operational']},{label:'接入配置',views:['integrations','source-governance','field-channels']}];
export function workspaceTabs(navigation,current){
 const view=canonicalView(current),group=workspaceGroups.find(g=>g.views.includes(view));if(!group)return '';const items=group.views.filter(v=>navigation.some(n=>n[0]===v)),seen=new Set();if(items.length<2)return ''; 
 const tab=(id,label,active)=>`<button data-action="nav" data-view="${id}" aria-current="${active?'page':'false'}" class="${active?'active':''}">${esc(label)}</button>`;
 const cluster=clusters.find(c=>c.views.includes(view));
 const main=items.map(id=>{const c=clusters.find(c=>c.views.includes(id));if(c){if(seen.has(c.label))return '';seen.add(c.label);return tab(c.views.find(v=>items.includes(v)),c.label,c.views.includes(view));}return tab(id,id==='overview'?'业务概况':id==='approvals'?'待审核':id==='data-center'?'设备档案与测点':navigation.find(n=>n[0]===id)[2],id===view);}).join('');
 const sub=cluster?`<nav class="workspace-tabs workspace-subtabs" aria-label="${cluster.label}分类">${cluster.views.filter(id=>items.includes(id)).map(id=>tab(id,navigation.find(n=>n[0]===id)[2],id===view)).join('')}</nav>`:'';
 return `<div class="workspace-context"><span>${group.label}</span><nav class="workspace-tabs" aria-label="${group.label}二级导航">${main}</nav>${sub}</div>`;
}
