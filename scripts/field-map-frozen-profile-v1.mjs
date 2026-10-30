import {isAbsolute,resolve} from 'node:path';
import {realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {coldRuntimeInventoryV1,coldRuntimeStructureV1} from './runtime-cold-facts-v1.mjs';

export const frozenMapNeedV1=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});};
export const frozenMapHashV1=v=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
export const frozenMapEqualV1=(a,b)=>canonical(a)===canonical(b);
export const frozenMapIdentV1=v=>{frozenMapNeedV1(typeof v==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(v),'FIELD_MAP_FROZEN_IDENTIFIER');return '"'+v+'"';};
const need=frozenMapNeedV1,exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(','),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),oid=v=>typeof v==='string'&&/^[1-9][0-9]{0,9}$/.test(v)&&BigInt(v)<=4294967295n;
export const frozenMapRevisionV1=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=9223372036854775807n;
export const frozenMapUuidV1=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)&&!/^0{8}(?:-0{4}){3}-0{12}$/.test(v);
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
const normal=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
export function fieldMapFrozenProfileV1(raw){
 need(exact(raw,['format','tenantId','targetDirectory','inventory','structureSha256','binding','fenceBinding','closed'])&&raw.format==='FIELD_MAP_FROZEN_PROFILE_V1','FIELD_MAP_FROZEN_PROFILE_FIELDS');
 need(typeof raw.tenantId==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(raw.tenantId)&&typeof raw.targetDirectory==='string'&&isAbsolute(raw.targetDirectory)&&raw.targetDirectory.length<=4096&&!/[\x00-\x1f\x7f]/.test(raw.targetDirectory)&&hash(raw.structureSha256),'FIELD_MAP_FROZEN_PROFILE_BINDING');
 const i=raw.inventory;need(exact(i,['identity','databases','roles','memberships'])&&exact(i.identity,['system_id','directory','control_oid','standby'])&&typeof i.identity.system_id==='string'&&/^[1-9][0-9]{0,19}$/.test(i.identity.system_id)&&oid(i.identity.control_oid)&&typeof i.identity.directory==='string'&&isAbsolute(i.identity.directory)&&i.identity.standby===false,'FIELD_MAP_FROZEN_INVENTORY');
 need(Array.isArray(i.roles)&&i.roles.length>0&&i.roles.length<=512&&Array.isArray(i.databases)&&i.databases.length>0&&i.databases.length<=256&&Array.isArray(i.memberships)&&i.memberships.length<=1024,'FIELD_MAP_FROZEN_INVENTORY_LIMIT');
 const roleIds=new Set(),roleNames=new Set(),dbIds=new Set(),dbNames=new Set();
 for(const r of i.roles){
  need(exact(r,['oid','rolname','rolcanlogin','rolconnlimit','rolsuper','rolcreatedb','rolcreaterole','rolinherit','rolreplication','rolbypassrls','rolconfig','rolvaliduntil'])&&oid(r.oid)&&r.oid!==i.identity.control_oid&&!roleIds.has(r.oid)&&!roleNames.has(r.rolname),'FIELD_MAP_FROZEN_ROLE');frozenMapIdentV1(r.rolname);roleIds.add(r.oid);roleNames.add(r.rolname);
  need(['rolcanlogin','rolsuper','rolcreatedb','rolcreaterole','rolinherit','rolreplication','rolbypassrls'].every(k=>typeof r[k]==='boolean')&&!r.rolsuper&&!r.rolcreatedb&&!r.rolcreaterole&&!r.rolreplication&&!r.rolbypassrls&&Number.isInteger(r.rolconnlimit)&&r.rolconnlimit>=-1&&r.rolconnlimit<=2147483647,'FIELD_MAP_FROZEN_ROLE_PROFILE');
  need((r.rolconfig===null||Array.isArray(r.rolconfig)&&r.rolconfig.length<=128&&r.rolconfig.every(v=>typeof v==='string'&&v.length<=4096))&&(r.rolvaliduntil===null||typeof r.rolvaliduntil==='string'&&r.rolvaliduntil.length<=64),'FIELD_MAP_FROZEN_ROLE_PROFILE');
 }
 for(const d of i.databases){need(exact(d,['oid','datname','datdba','datallowconn','datconnlimit','datacl'])&&oid(d.oid)&&roleIds.has(d.datdba)&&!dbIds.has(d.oid)&&!dbNames.has(d.datname)&&d.datname!=='postgres'&&typeof d.datallowconn==='boolean'&&Number.isInteger(d.datconnlimit)&&d.datconnlimit>=-1&&d.datconnlimit<=2147483647&&(d.datacl===null||typeof d.datacl==='string'&&d.datacl.length<=65536),'FIELD_MAP_FROZEN_DATABASE');frozenMapIdentV1(d.datname);dbIds.add(d.oid);dbNames.add(d.datname);}
 const members=new Set();for(const m of i.memberships){const key=m?.roleid+':'+m?.member+':'+m?.grantor;need(exact(m,['roleid','member','grantor','admin_option','inherit_option','set_option'])&&[m.roleid,m.member,m.grantor].every(oid)&&['admin_option','inherit_option','set_option'].every(k=>typeof m[k]==='boolean')&&!members.has(key),'FIELD_MAP_FROZEN_MEMBERSHIP');members.add(key);}
 const b=raw.binding,f=raw.fenceBinding;
 need(exact(b,['tenantId','databaseOid','roleOid','catalogHash'])&&b.tenantId===raw.tenantId&&dbIds.has(b.databaseOid)&&roleIds.has(b.roleOid)&&hash(b.catalogHash),'FIELD_MAP_FROZEN_MAP_BINDING');
 need(exact(f,['format','deployment','host','port','systemIdentifier','database','databaseOid','ownerOid','controlOid','actorOids','catalogHash'])&&f.format==='RUNTIME_WRITE_FENCE_BINDING_V1'&&frozenMapUuidV1(f.deployment)&&['127.0.0.1','::1'].includes(f.host)&&Number.isInteger(f.port)&&f.port>1024&&f.port<=65535&&f.systemIdentifier===i.identity.system_id&&f.databaseOid===b.databaseOid&&f.controlOid===i.identity.control_oid&&roleIds.has(f.ownerOid)&&hash(f.catalogHash),'FIELD_MAP_FROZEN_FENCE_BINDING');
 need(i.databases.some(d=>d.oid===f.databaseOid&&d.datname===f.database)&&Array.isArray(f.actorOids)&&f.actorOids.length>0&&new Set(f.actorOids).size===f.actorOids.length&&f.actorOids.every(v=>roleIds.has(v)&&i.roles.some(r=>r.oid===v&&r.rolcanlogin&&!r.rolinherit))&&f.actorOids.includes(b.roleOid),'FIELD_MAP_FROZEN_FENCE_ACTORS');
 need(exact(raw.closed,['operationId','revision'])&&frozenMapUuidV1(raw.closed.operationId)&&frozenMapRevisionV1(raw.closed.revision),'FIELD_MAP_FROZEN_CLOSED_BINDING');
 return freeze(JSON.parse(JSON.stringify(raw)));
}
export function fieldMapFrozenInventoryV1(profile,staged=false){
 const value=structuredClone(profile.inventory);value.identity.directory=profile.targetDirectory;
 if(!staged){for(const r of value.roles){r.rolcanlogin=false;r.rolconnlimit=0;}for(const d of value.databases)d.datconnlimit=0;}
 return value;
}
export async function assertFieldMapFrozenProfileV1(client,profile,staged=false){
 const actual=await coldRuntimeInventoryV1(client),expected=fieldMapFrozenInventoryV1(profile,staged);
 // Preserve the original capture representation; never infer role expiry from an empty object.
 for(const r of actual.roles)if(r.rolvaliduntil instanceof Date)r.rolvaliduntil=r.rolvaliduntil.toISOString();
 need(normal(await realpath(actual.identity.directory))===normal(profile.targetDirectory)&&normal(await realpath(profile.targetDirectory))===normal(profile.targetDirectory),'FIELD_MAP_FROZEN_TARGET_ALIAS');
 need(frozenMapEqualV1(actual,expected),'FIELD_MAP_FROZEN_INVENTORY_CHANGED');
 need(await coldRuntimeStructureV1(client)===profile.structureSha256,'FIELD_MAP_FROZEN_STRUCTURE_CHANGED');
 return frozenMapHashV1(expected);
}
export async function setFieldMapFrozenProfileV1(client,profile,staged){
 for(const r of profile.inventory.roles)await client.query('ALTER ROLE '+frozenMapIdentV1(r.rolname)+' '+(staged&&r.rolcanlogin?'LOGIN':'NOLOGIN')+' CONNECTION LIMIT '+(staged?r.rolconnlimit:0));
 for(const d of profile.inventory.databases)await client.query('ALTER DATABASE '+frozenMapIdentV1(d.datname)+' CONNECTION LIMIT '+(staged?d.datconnlimit:0));
}
