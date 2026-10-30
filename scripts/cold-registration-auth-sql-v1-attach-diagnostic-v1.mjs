import pg from 'pg';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {validateAuthRuntime,verifyAuthStore} from '../server/auth-store.ts';
import {openState,validateKeyRing,sessionLifetime} from '../server/auth-state.ts';
import {captureColdReviewSqlFactsV1,assertColdReviewSqlFactsV1,validateColdReviewSqlFactsV1} from './cold-review-sql-facts-v2.mjs';
import {coldReviewInventoryV3} from './runtime-cold-review-target-v9-attach-diagnostic-v1.mjs';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';

const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const same=(a,b)=>canonical(a)===canonical(b),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const q=v=>{need(typeof v==='string'&&/^[a-z_][a-z0-9_]{0,62}$/.test(v),'COLD_REGISTRATION_AUTH_ROLE');return '"'+v+'"';};

/** Caller owns the actual transaction and any staged ORIGINAL catalog profile. No COMMIT or business DML. */
export async function verifyColdRegistrationAuthSqlV1(client,options){
 let savepoint=null,problem,result;
 try{
  need(client instanceof pg.Client&&client.getTransactionStatus()==='T'&&exact(options,['baseline','runtime','ring','originalInventory','targetDirectory']),'COLD_REGISTRATION_AUTH_TRANSACTION');
  const {baseline,originalInventory,targetDirectory}=options,runtime=validateAuthRuntime(options.runtime,options.runtime?.deploymentDigest),ring=validateKeyRing(options.ring);validateColdReviewSqlFactsV1(baseline);
  need(typeof targetDirectory==='string'&&resolve(targetDirectory)===targetDirectory&&baseline.identity.database===runtime.account.database&&originalInventory.identity.system_id===baseline.identity.systemIdentifier&&originalInventory.identity.control_oid===baseline.identity.controlOid,'COLD_REGISTRATION_AUTH_BINDING');
  const role=originalInventory.roles.find(r=>r.rolname===runtime.account.user),database=originalInventory.databases.find(d=>d.datname===runtime.account.database),stateRelation=baseline.relations.find(r=>r.schema==='public'&&r.name==='auth_state'&&r.kind==='r');
  need(role&&database?.oid===baseline.identity.databaseOid&&stateRelation&&Number.isSafeInteger(stateRelation.rows),'COLD_REGISTRATION_AUTH_SOURCE_COVERAGE');
  const isolation=(await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation;need(['repeatable read','serializable'].includes(isolation),'COLD_REGISTRATION_AUTH_SNAPSHOT');
  const expected=structuredClone(originalInventory);expected.identity.directory=targetDirectory;
  const beforeInventory=await coldReviewInventoryV3(client,targetDirectory);need(same(beforeInventory,expected),'COLD_REGISTRATION_AUTH_ORIGINAL_PROFILE');
  const before=await captureColdReviewSqlFactsV1(client,baseline.identity);assertColdReviewSqlFactsV1(before,baseline);
  savepoint='registration_auth_'+randomUUID().replaceAll('-','');await client.query('SAVEPOINT '+savepoint);
  await client.query('SET LOCAL SESSION AUTHORIZATION '+q(runtime.account.user));
  const actor=(await client.query('SELECT session_user::regrole::oid::text AS session_oid,current_user::regrole::oid::text AS current_oid')).rows[0];need(actor.session_oid===role.oid&&actor.current_oid===role.oid,'COLD_REGISTRATION_AUTH_EFFECTIVE_ROLE');
  await verifyAuthStore(client,runtime,ring);
  const cursor='registration_auth_rows_'+randomUUID().replaceAll('-','');await client.query('DECLARE '+cursor+' NO SCROLL CURSOR FOR SELECT scope_hash,kind,lookup_hash,revision,expires_at,sealed FROM public.auth_state ORDER BY kind,scope_hash,lookup_hash');
  let rows=0,batches=0,login=0,sessions=0,expired=0;const usedKeys=new Set();
  for(;;){const batch=(await client.query('FETCH FORWARD 128 FROM '+cursor)).rows;if(!batch.length)break;batches++;
   for(const row of batch){
    need(++rows<=stateRelation.rows&&hex(row.scope_hash)&&hex(row.lookup_hash)&&['LOGIN','SESSION'].includes(row.kind)&&Number.isSafeInteger(row.revision)&&row.revision>0,'COLD_REGISTRATION_AUTH_ROW');
    const expires=new Date(row.expires_at).getTime();need(Number.isSafeInteger(expires),'COLD_REGISTRATION_AUTH_EXPIRY');
    const value=openState(row.sealed,{deployment:runtime.deploymentDigest,scope:row.scope_hash,kind:row.kind,lookup:row.lookup_hash,revision:row.revision,expires},ring);
    need(value&&Object.getPrototypeOf(value)===Object.prototype,'COLD_REGISTRATION_AUTH_PLAINTEXT');
    if(row.kind==='SESSION'){need(Number.isSafeInteger(value.createdAt)&&value.createdAt+sessionLifetime===expires,'COLD_REGISTRATION_AUTH_SESSION_LIFETIME');sessions++;}else{need(value.expires===expires,'COLD_REGISTRATION_AUTH_LOGIN_LIFETIME');login++;}
    if(expires<=Date.now())expired++;usedKeys.add(row.sealed.keyId);
   }
  }
  await client.query('CLOSE '+cursor);need(rows===stateRelation.rows&&rows===login+sessions,'COLD_REGISTRATION_AUTH_ROW_COVERAGE');
  result={format:'COLD_REGISTRATION_AUTH_SQL_EVIDENCE_V1',scope:'ONE_REGISTERED_AUTH_DATABASE',sourceSqlFactsSha256:baseline.sha256,databaseOid:database.oid,authRoleOid:role.oid,deploymentDigest:runtime.deploymentDigest,rows,loginRows:login,sessionRows:sessions,expiredRowsPreserved:expired,batches,keyIdsUsed:usedKeys.size,actualAuthSchemaAndPrivilegesVerified:true,actualKeyWitnessDecrypted:true,everyCapturedAuthenticationRowDecrypted:true,allCapturedRowsIncludingExpiredPreserved:true,rootSessionRestorationVerified:false,callerOwnsTransaction:true,authRolePasswordAuthenticated:false,currentOidcIdentityVerified:false,allEncryptedApplicationStateVerified:false,completeDeploymentMaterialsVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false};
 }catch(e){problem=e;}finally{
  if(savepoint){try{need(['T','E'].includes(client.getTransactionStatus()),'COLD_REGISTRATION_AUTH_TRANSACTION_ENDED');await client.query('ROLLBACK TO SAVEPOINT '+savepoint);await client.query('RELEASE SAVEPOINT '+savepoint);const root=(await client.query('SELECT session_user::regrole::oid::text AS session_oid,current_user::regrole::oid::text AS current_oid')).rows[0];need(root.session_oid===options.baseline.identity.controlOid&&root.current_oid===root.session_oid,'COLD_REGISTRATION_AUTH_ROOT_NOT_RESTORED');}catch(e){const safe=Object.assign(Error('COLD_REGISTRATION_AUTH_ROOT_RESTORATION_UNPROVEN'),{code:'COLD_REGISTRATION_AUTH_ROOT_RESTORATION_UNPROVEN'});problem=safe;}}
 }
 if(problem){const code=/^COLD_REGISTRATION_AUTH_[A-Z0-9_]+$/.test(problem?.code??'')?problem.code:'COLD_REGISTRATION_AUTH_SQL_UNVERIFIABLE';throw Object.assign(Error(code),{code});}
 try{
  const after=await captureColdReviewSqlFactsV1(client,options.baseline.identity);assertColdReviewSqlFactsV1(after,options.baseline);
  const expected=structuredClone(options.originalInventory);expected.identity.directory=options.targetDirectory;need(same(await coldReviewInventoryV3(client,options.targetDirectory),expected),'COLD_REGISTRATION_AUTH_PROFILE_CHANGED');
  result.rootSessionRestorationVerified=true;result.completeSqlFactsUnchanged=true;return{...result,sha256:hash(result)};
 }catch{throw Object.assign(Error('COLD_REGISTRATION_AUTH_FINAL_FACTS_UNVERIFIABLE'),{code:'COLD_REGISTRATION_AUTH_FINAL_FACTS_UNVERIFIABLE'});}
}
