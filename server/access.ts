import { DomainError } from './service.ts';

export interface AccessContext {
  tenantId: string; actorId: string; actorType: string; correlationId: string;
  authMode?: 'demo' | 'oidc'; roles?: string[]; permissions?: string[];
  /** Trusted, server-derived enterprise scope assignments. Never read from request headers. */
  scope?: ScopeClaims;
}
export type ScopeClaims = {
  sites: string[];
  lines: string[];
  devices: string[];
  provided: boolean;
};
export type DataScope = 'TENANT' | 'SITE' | 'LINE' | 'OWN_TASKS' | 'READONLY_TENANT';
const roleDataScopes: Record<string, DataScope> = {
  'tenant-admin':'TENANT','system-admin':'TENANT','platform-certifier':'TENANT',
  'equipment-admin':'SITE','data-uploader':'SITE','quality-engineer':'SITE','production-supervisor':'SITE','spare-parts-clerk':'SITE','final-approver':'SITE',
  'maintenance-engineer':'LINE','operator':'OWN_TASKS','auditor':'READONLY_TENANT'
};
export function requiredScope(roles: string[]): DataScope {
  const scopes=roles.map(r=>roleDataScopes[r]).filter(Boolean);
  if(scopes.includes('TENANT')) return 'TENANT';
  if(scopes.includes('SITE')) return 'SITE';
  if(scopes.includes('LINE')) return 'LINE';
  if(scopes.includes('OWN_TASKS')) return 'OWN_TASKS';
  return 'READONLY_TENANT';
}
const wildcard=(values:string[])=>values.length===0||values.includes('*');
export function scopeFilter(ctx: AccessContext): {sites:string[]|null;lines:string[]|null;devices:string[]|null} {
  const required=ctx.authMode==='oidc'?requiredScope(ctx.roles||[]):'TENANT';
  if(required==='TENANT'||required==='READONLY_TENANT') return {sites:null,lines:null,devices:null};
  const scope=ctx.scope;
  // OIDC scoped roles must carry an administrator-managed assignment. Missing or empty
  // assignments fail closed; local unit/demo contexts retain their historical tenant scope.
  // Direct domain callers (for example migration/unit fixtures) may not carry
  // an auth-issued scope object. HTTP OIDC identities always include `scope`
  // and are rejected earlier when a scoped role lacks an assignment.
  if(ctx.authMode==='oidc'&&!scope) return {sites:null,lines:null,devices:null};
  if(ctx.authMode==='oidc'&&!scope!.provided) return {sites:[],lines:[],devices:[]};
  const sites=scope?.sites||[],lines=scope?.lines||[],devices=scope?.devices||[];
  return {sites:wildcard(sites)?null:sites,lines:wildcard(lines)?null:lines,devices:wildcard(devices)?null:devices};
}
export function scopeAllows(ctx: AccessContext, record: {site_code?:unknown;line_code?:unknown;device_code?:unknown;deviceCode?:unknown;line?:unknown}): boolean {
  const filter=scopeFilter(ctx),site=String(record.site_code??''),line=String(record.line_code??record.line??''),device=String(record.device_code??record.deviceCode??'');
  return (filter.sites===null||filter.sites.includes(site))&&(filter.lines===null||filter.lines.includes(line))&&(filter.devices===null||filter.devices.includes(device));
}
export function scopeClaimsFromPayload(payload: Record<string, unknown>): ScopeClaims {
  const values=(key:string)=>{const value=payload[key],items=Array.isArray(value)?value:typeof value==='string'?value.split(','):[];return [...new Set(items.filter((v):v is string=>typeof v==='string').map(v=>v.trim()).filter(v=>/^[A-Za-z0-9._*-]{1,128}$/.test(v)))];};
  const sites=values('idms_sites'),lines=values('idms_lines'),devices=values('idms_devices');
  return {sites,lines,devices,provided:[sites,lines,devices].some(v=>v.length>0)};
}
export const rolePermissions: Record<string, string[]> = {
  'tenant-admin': ['read', 'template:edit', 'template:submit', 'plugin:submit'],
  'system-admin': ['read'],
  'platform-certifier': ['read', 'plugin:certify'],
  'equipment-admin': ['read', 'upload', 'analyze'],
  'data-uploader': ['read', 'upload', 'analyze'],
  'maintenance-engineer': ['read', 'maintenance:execute', 'analyze', 'alarm:review'],
  'quality-engineer': ['read'],
  'production-supervisor': ['read', 'analyze'],
  operator: ['read', 'maintenance:execute', 'analyze', 'alarm:review'],
  'spare-parts-clerk': ['read'],
  'final-approver': ['read', 'approve', 'analyze', 'predictive:approve', 'maintenance:approve', 'alarm:approve', 'template:publish', 'plugin:activate'],
  auditor: ['read']
};
const demoGrants: Record<string, string[]> = {
  'demo.admin': ['read', 'template:submit'],
  'demo.uploader': ['read', 'upload', 'analyze'],
  'demo.approver': ['read', 'approve', 'analyze', 'predictive:approve', 'maintenance:approve', 'alarm:approve'],
  'demo.technician': ['read', 'maintenance:execute', 'analyze', 'alarm:review'],
  'demo.auditor': ['read'], 'demo.connector': ['read', 'upload']
};
export const sparesPermissionLabels:Record<string,string>={
 'spares:read':'查看备件采购资料','spares:history':'查询备件业务历史','spares:manage':'维护备件、仓库、供应商及工单用料计划，执行采购收货',
 'spares:request':'编制并提交采购申请','spares:move':'设备领退料、登记实际更换及维护本人负责工单的用料计划','spares:approve':'独立审批采购及库存调整','spares:finance':'登记发票与付款凭证（不执行支付）'
};
const sparesWrites=['spares:manage','spares:request','spares:move','spares:approve','spares:finance'];
// Make existing domain capabilities visible in the same catalog as the other
// permissions. This changes no identity-provider role assignments.
for(const grants of Object.values(rolePermissions))if(grants.includes('read'))grants.push('spares:read','spares:history');
for(const role of ['tenant-admin','spare-parts-clerk'])rolePermissions[role].push('spares:manage','spares:request','spares:move','spares:finance');
for(const role of ['data-uploader','maintenance-engineer'])rolePermissions[role].push('spares:request');
rolePermissions['maintenance-engineer'].push('spares:move');
rolePermissions['final-approver'].push('spares:approve');
for(const grants of Object.values(demoGrants))if(grants.includes('read'))grants.push('spares:read','spares:history');
demoGrants['demo.admin'].push('spares:manage','spares:request','spares:move','spares:finance');
demoGrants['demo.uploader'].push('spares:request');demoGrants['demo.technician'].push('spares:request','spares:move');demoGrants['demo.approver'].push('spares:approve');
export function permissionsFor(roles: string[]) {
  const grants=[...new Set(roles.flatMap(r => rolePermissions[r] || []))];
  // Platform operations never obtains business responsibility by stacking another role.
  return roles.includes('system-admin')?grants.filter(p=>!p.includes('approve')&&!['template:publish','plugin:activate','plugin:certify',...sparesWrites].includes(p)):grants;
}
export function hasAccess(ctx:AccessContext,permission:string){
 const grants=ctx.authMode==='oidc'?permissionsFor(ctx.roles||[]):demoGrants[ctx.actorId]||[];
 if(!grants.includes(permission))return false;
 if(permission==='spares:history'&&ctx.actorType!=='USER')return false;
 if(sparesWrites.includes(permission)&&(ctx.actorType!=='USER'||ctx.roles?.includes('system-admin')))return false;
 return true;
}
export function requireAccess(ctx: AccessContext, permission: string) {
  if (!hasAccess(ctx,permission)) throw new DomainError(403, '当前身份无此操作权限');
  if (permission !== 'read' && !['USER', 'INTERFACE'].includes(ctx.actorType)) throw new DomainError(403, '该身份不可执行业务写入');
  if ((permission.includes('approve') || permission.startsWith('maintenance:') || ['template:publish','template:edit','template:submit','plugin:certify','plugin:activate'].includes(permission)) && ctx.actorType !== 'USER') throw new DomainError(403, '责任动作必须由真实用户执行');
}
