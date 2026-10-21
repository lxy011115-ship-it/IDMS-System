import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {createPredictiveAdoptionUiBusinessQaV4} from './predictive-adoption-ui-business-v4-qa.mjs';
import {governanceJobsAuthQaV4} from './governance-jobs-auth-qa-v4.mjs';
import {authAuditSchemaSqlV4} from '../auth-audit-schema-v4.mjs';
import {inspectAuthAuditCatalogV4} from '../../server/auth-audit-catalog-v4.ts';
import {AuthAuditCryptoV4,deriveAuthAuditKeyRingV4} from '../../server/auth-audit-event-v4.ts';
import {sha,stable} from '../../server/auth-state.ts';
const q=s=>{assert.match(s,/^[a-z][a-z0-9_]{0,62}$/);return '"'+s+'"';};
export async function createPredictiveAdoptionUiSessionQaV4(){
 const qa=await createPredictiveAdoptionUiBusinessQaV4(),admin=new pg.Client(qa.adminAccount),closers=[];await admin.connect();let auth,rolePin,closed=false;
 const close=async()=>{if(closed)return;for(const c of closers.toReversed())await c.close();await auth?.close();if(rolePin){assert.equal((await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[rolePin.name])).rows[0]?.oid,rolePin.oid);assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usesysid=$1::oid',[rolePin.oid])).rows[0].n,0);await admin.query('DROP ROLE '+q(rolePin.name));}await qa.close();await admin.end();await writeFile(join(qa.work,'auth-audit-cleanup.json'),JSON.stringify({databasesRemoved:5,rolesRemoved:rolePin?21:20,exactOidOwnerAndZeroBackends:true,force:false,backendTermination:false}));closed=true;};
 try{
  auth=await governanceJobsAuthQaV4(qa);const name='idms_audqa_'+qa.nonce+'_delivery',password=randomBytes(32).toString('base64url');assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).rowCount,0);await admin.query(`CREATE ROLE ${q(name)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`);rolePin={name,oid:(await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0].oid};await writeFile(join(qa.work,'auth-audit-delivery-role.private.json'),JSON.stringify(rolePin));await admin.query(`GRANT CONNECT ON DATABASE ${q(auth.runtime.account.database)} TO ${q(name)}`);
  const root=new pg.Client({...qa.adminAccount,database:auth.runtime.account.database});await root.connect();let databaseOid,catalogHash,appOid,auditRing;try{databaseOid=(await root.query('SELECT oid::text FROM pg_database WHERE datname=current_database()')).rows[0].oid;appOid=(await root.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[auth.runtime.account.user])).rows[0].oid;auditRing=deriveAuthAuditKeyRingV4(auth.ring,{deployment:auth.runtime.deploymentDigest,databaseOid});const keyCheck=new AuthAuditCryptoV4(auditRing,{deployment:auth.runtime.deploymentDigest,databaseOid}).witness();await root.query('BEGIN');await root.query(await authAuditSchemaSqlV4({owner:auth.runtime.account.ownerRole,app:auth.runtime.account.user,delivery:name,deployment:auth.runtime.deploymentDigest,keyCheck}));await root.query('COMMIT');catalogHash=await inspectAuthAuditCatalogV4(root);}finally{await root.end();}
  const common={deployment:auth.runtime.deploymentDigest,databaseOid,catalogHash},appAccount={host:auth.runtime.host,port:auth.runtime.port,...auth.runtime.account},deliveryAccount={host:auth.runtime.host,port:auth.runtime.port,user:name,password,database:auth.runtime.account.database};
  return {...qa,auth,auditRing,appAccount,deliveryAccount,track(value){closers.push(value);return value;},bindings(config){const scope=sha(stable({deployment:auth.runtime.deploymentDigest,issuer:config.issuer,clientId:config.clientId,audience:config.audience,origin:new URL(config.origin).origin}));return {app:{...common,scope,roleOid:appOid},delivery:{...common,scope,roleOid:rolePin.oid}};},close};
 }catch(e){await close();throw e;}
}
