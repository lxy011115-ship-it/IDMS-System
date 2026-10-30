import assert from 'node:assert/strict';
import test from 'node:test';
import {splitColdProgramSqlStatementsV1 as split,compileColdProgramPrivilegePolicyV1 as compile,loadColdMapProgramPrivilegePoliciesV1 as load} from '../scripts/cold-map-program-privilege-policy-v1.mjs';
import {reviewSourceHashV1 as hash} from '../scripts/workflow-review-source-facts-v1.mjs';

test('SQL framing separates statements while retaining quoted and dollar-quoted bodies',()=>{
  const sql="-- GRANT ignored\nCREATE FUNCTION qa.f() RETURNS text AS $body$ BEGIN RETURN 'GRANT EXECUTE ON FUNCTION qa.fake() TO idms_policy_worker;'; END $body$ LANGUAGE plpgsql; /* outer /* inner ; */ */ GRANT EXECUTE ON FUNCTION qa.f() TO \"idms_policy_worker\"; SELECT 'a'';b',\"semi;colon\";";
  const statements=split(sql);assert.equal(statements.length,3);assert(statements[0].startsWith('CREATE FUNCTION'));assert(statements[1].startsWith('GRANT EXECUTE'));assert.equal(compile({schema:'qa',sql}).functionExecute.length,1);assert.equal(compile({schema:'qa',sql}).functionExecute[0].target,'qa.f()');
});

test('unfinished SQL and unsupported privilege expansion fail closed',()=>{
  for(const sql of ["SELECT 'unfinished",'SELECT $$unfinished','SELECT 1 /* unclosed','SELECT \0',"GRANT EXECUTE ON FUNCTION qa.f() TO PUBLIC;","GRANT EXECUTE ON FUNCTION qa.f() TO unknown;","GRANT EXECUTE ON FUNCTION foreign_schema.f() TO idms_policy_worker;","GRANT EXECUTE ON FUNCTION qa.f() TO idms_policy_worker WITH GRANT OPTION;","GRANT INSERT ON qa.t TO idms_policy_worker;"])assert.throws(()=>compile({schema:'qa',sql}),error=>/^COLD_PROGRAM_POLICY_/.test(error.code));
});

test('real state-map4 and console4 installer grants preserve reader and queue-ingress distinctions',async()=>{
  const policies=await load();assert.equal(policies.length,5);const map=policies.find(value=>value.schema==='state_map_v1'),consolePolicy=policies.find(value=>value.schema==='governance_jobs_v4');
  const fn=(policy,name)=>policy.functionExecute.find(value=>value.target.startsWith(policy.schema+'.'+name+'('))?.roles??[];
  assert.deepEqual(map.schemaUsageRoles,['reader','worker']);assert.deepEqual(map.tableSelect.map(value=>value.target).sort(),['state_map_v1.head','state_map_v1.kv_values','state_map_v1.nodes','state_map_v1.receipts']);assert.deepEqual(fn(map,'read_head_v1'),['reader','worker']);assert.deepEqual(fn(map,'apply_delta_v1'),['worker']);assert.deepEqual(fn(map,'publish_branch_v1'),[]);
  assert.deepEqual(consolePolicy.schemaUsageRoles,['ingress','worker']);assert.deepEqual(fn(consolePolicy,'enqueue_v4'),[]);assert.deepEqual(fn(consolePolicy,'enqueue_console_v4'),['ingress']);assert.deepEqual(fn(consolePolicy,'prepare_v4'),[]);assert.deepEqual(fn(consolePolicy,'prepare_console_v4'),['worker']);assert.deepEqual(consolePolicy.tableSelect,[]);
});

test('actual adoption and UI installer rename/revoke steps remove private entry-point grants',async()=>{
  const policies=await load(),predictive=policies.find(value=>value.schema==='predictive_jobs_v4'),reconciliation=policies.find(value=>value.schema==='reconciliation_jobs_v1');const fn=(policy,name)=>policy.functionExecute.find(value=>value.target.startsWith(policy.schema+'.'+name+'('))?.roles??[];
  assert.deepEqual(fn(predictive,'read_adoption_v4'),['ingress','worker']);assert.deepEqual(fn(predictive,'prepare_adoption_v4'),['worker']);assert.deepEqual(fn(reconciliation,'_authorize_core_ui_v1'),[]);assert.deepEqual(fn(reconciliation,'authorize_v1'),['ingress']);assert.deepEqual(fn(reconciliation,'browse_ui_v1'),['ingress','worker']);assert(reconciliation.renames>=1);
});

test('an explicit function rename carries grants until its new private name is revoked',()=>{
  const sql='GRANT EXECUTE ON FUNCTION qa.f(text) TO idms_policy_worker; ALTER FUNCTION qa.f(text) RENAME TO private_f; REVOKE ALL ON FUNCTION qa.private_f(text) FROM idms_policy_worker,PUBLIC; GRANT EXECUTE ON FUNCTION qa.f(text) TO idms_policy_ingress;';const value=compile({schema:'qa',sql});assert.deepEqual(value.functionExecute,[{target:'qa.f(text)',roles:['ingress']}]);assert.equal(value.renames,1);
});

test('cached source policies are deeply immutable descriptions and grant no live permission',async()=>{
  const policies=await load();assert.equal(await load(),policies);assert.throws(()=>policies.push({}),TypeError);for(const value of policies){const {sha256,...body}=value;assert.equal(hash(body),sha256);assert(value.sourceTextDescriptionOnly);assert.equal(value.actualPrivilegesVerified,false);assert.equal(value.authorizationGranted,false);assert.equal(value.fullRegisteredRoleMatrixVerified,false);assert.throws(()=>value.schemaUsageRoles.push('foreign'),TypeError);if(value.functionExecute.length)assert.throws(()=>value.functionExecute[0].roles.push('foreign'),TypeError);}
});
