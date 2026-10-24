import {createHash} from 'node:crypto';
import {FieldRecoveryAuthorityLock} from './field-recovery-lock.mjs';
import {fieldMapFrozenProfileV2,frozenMapNeedV1 as need} from './field-map-frozen-profile-v2.mjs';
const records=new WeakMap(),family=0x49445246,sha=v=>createHash('sha256').update(v).digest('hex');

/** Creates and retains the original lock owner. Never accepts a PID or an adopted SQL connection. */
export async function createOwnedFieldRecoveryGuardV1({authority,profile,controlFile}){
 const p=fieldMapFrozenProfileV2(profile);need(authority?.host===p.fenceBinding.host&&authority?.port===p.fenceBinding.port&&typeof authority.bootstrapPassword==='string'&&authority.bootstrapPassword.length>=32,'FIELD_OWNED_GUARD_BINDING');
 const guard=new FieldRecoveryAuthorityLock(authority,p.tenantId);if(controlFile)guard.setWorkspace(controlFile);
 try{await guard.acquire();need(guard.authorityId===sha('postgres:'+p.inventory.identity.system_id),'FIELD_OWNED_GUARD_AUTHORITY');}
 catch(e){await guard.close();throw e;}
 const record={guard,tenantId:p.tenantId,systemIdentifier:p.inventory.identity.system_id,controlOid:p.inventory.identity.control_oid,host:authority.host,port:authority.port,key:Buffer.from(sha(p.tenantId),'hex').readUInt32BE(0),closed:false};
 const capability=Object.freeze({guard,async assertHeld(){need(!record.closed,'FIELD_OWNED_GUARD_CLOSED');await guard.assertHeld();},close(){record.closed=true;return record.closeJob??=(guard.close());}});
 records.set(capability,record);return capability;
}

/** The unique advisory lock is rechecked on its original private connection on both sides of inspection. */
export async function assertOwnedFieldRecoveryPeersV1(client,profile,capabilities=[]){
 need(Array.isArray(capabilities)&&capabilities.length<=1&&new Set(capabilities).size===capabilities.length,'FIELD_OWNED_GUARD_SET');const owned=[];
 for(const c of capabilities){const r=records.get(c);need(r&&!r.closed&&r.tenantId===profile.tenantId&&r.systemIdentifier===profile.inventory.identity.system_id&&r.controlOid===profile.inventory.identity.control_oid&&r.host===profile.fenceBinding.host&&r.port===profile.fenceBinding.port,'FIELD_OWNED_GUARD_NOT_MINTED');await r.guard.assertHeld();
  const rows=(await client.query("SELECT a.pid,a.usesysid::text AS role,a.datid::text AS database_oid,a.application_name FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.classid=$1::oid AND l.objid=$2::oid AND l.objsubid=2 AND l.mode='ExclusiveLock' AND l.granted AND l.database=(SELECT oid FROM pg_database WHERE datname='postgres') AND a.datid=l.database AND a.backend_type='client backend'",[String(family),String(r.key)])).rows;
  need(rows.length===1&&rows[0].role===r.controlOid&&rows[0].application_name==='idms-field-recovery-control','FIELD_OWNED_GUARD_SESSION_CHANGED');owned.push(rows[0].pid);
 }
 const peers=(await client.query("SELECT pid FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid() ORDER BY pid")).rows.map(r=>r.pid);
 need(peers.length===owned.length&&peers.every(pid=>owned.includes(pid)),'FIELD_MAP_FROZEN_OTHER_SQL_CLIENT');for(const c of capabilities)await c.assertHeld();
}
