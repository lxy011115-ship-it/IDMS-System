import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createOwnedPlatformPgQaV1} from '../scripts/fixtures/owned-platform-pg-v1-qa.mjs';
import {verifyColdFieldPgScramV1 as verify} from '../scripts/cold-field-pg-scram-v1.mjs';
import {createColdFieldCurrentMaterialsV1} from '../scripts/cold-field-current-materials-v1.mjs';

let cluster,root,next=0;const roles=[];
before(async()=>{assert(process.env.IDMS_COLD_FIELD_PG_BIN&&process.env.IDMS_COLD_FIELD_PG_WORK);cluster=await createOwnedPlatformPgQaV1(process.env.IDMS_COLD_FIELD_PG_BIN);root=await cluster.client();});
after(async()=>{
  if(root)await root.end();if(cluster)await cluster.stop();
  const terminal={format:'COLD_FIELD_SCRAM_ACTUAL_PG_TERMINAL_V1',clusterDirectory:cluster?.work??null,systemIdentifier:cluster?.systemIdentifier??null,postgresVersion:cluster?.tooling.binding.version??null,createdNewClusterOnly:true,rolesCreated:roles.length,allOriginalOwnedPostmastersNormallyStopped:!!cluster&&cluster.processes.length>0&&cluster.processes.every(value=>value.stopped),smartStopOnly:true,genericKillUsed:false,originalCaseOrSourceChanged:false,credentialsOrVerifiersPrinted:false};
  await writeFile(join(resolve(process.env.IDMS_COLD_FIELD_PG_WORK),'postgres-original-terminal-v1.json'),JSON.stringify(terminal,null,2)+'\n',{flag:'wx'});assert(terminal.allOriginalOwnedPostmastersNormallyStopped);
});
async function role(password){
  const name='field_scram_'+cluster.nonce+'_'+(++next);assert(/^[a-z0-9_]+$/.test(name));await root.query('CREATE ROLE "'+name+'" LOGIN PASSWORD '+pg.escapeLiteral(password));roles.push(name);const row=(await root.query('SELECT oid::text,rolname,rolpassword,rolcanlogin FROM pg_authid WHERE rolname=$1',[name])).rows[0];assert(row&&row.rolcanlogin&&row.rolpassword.startsWith('SCRAM-SHA-256$'));
  const client=new pg.Client({...cluster.account,user:name,password,connectionTimeoutMillis:5000,application_name:'idms-field-scram-actual-client'});try{await client.connect();const actual=(await client.query('SELECT current_user AS name')).rows[0];assert.equal(actual.name,name);}finally{await client.end();}
  return row;
}
async function rejected(password,verifier){await assert.rejects(verify(password,verifier),error=>error.code==='COLD_FIELD_PG_SCRAM_UNVERIFIABLE'&&error.message==='COLD_FIELD_PG_SCRAM_UNVERIFIABLE');}
function changed(verifier,which){const parts=verifier.split('$'),keys=parts[2].split(':'),bytes=Buffer.from(keys[which],'base64');bytes[0]^=1;keys[which]=bytes.toString('base64');return parts[0]+'$'+parts[1]+'$'+keys.join(':');}

test('actual server SCRAM verifier and real pg client authentication agree for generated ASCII passwords',async()=>{
  const password=randomBytes(32).toString('base64url'),record=await role(password),proof=await verify(password,record.rolpassword);assert(proof.actualPgDriverPasswordPreparationUsed&&proof.bothStoredAndServerKeysMatched);assert.equal(proof.sqlConnectionOpened,false);assert.equal(proof.loginOrPrivilegesProven,false);await rejected(password+'x',record.rolpassword);
});
test('actual server and driver Unicode/SASL preparation agree, including NFKC and mapped spaces',async()=>{
  const password='前缀Ａ\u00a0'+randomBytes(32).toString('base64url'),record=await role(password);assert((await verify(password,record.rolpassword)).bothStoredAndServerKeysMatched);assert((await verify(password.replace('Ａ\u00a0','A '),record.rolpassword)).bothStoredAndServerKeysMatched);
});
test('a changed StoredKey fails even if the actual server verifier ServerKey remains correct',async()=>{const password=randomBytes(32).toString('hex'),record=await role(password);await rejected(password,changed(record.rolpassword,0));});
test('a changed ServerKey fails even if the actual server verifier StoredKey remains correct',async()=>{const password=randomBytes(32).toString('base64url'),record=await role(password);await rejected(password,changed(record.rolpassword,1));});
test('malformed, noncanonical or excessive-work verifiers fail without public credential data',async()=>{
  const password=randomBytes(32).toString('base64url'),record=await role(password);for(const verifier of ['md5'+'0'.repeat(32),record.rolpassword.replace('$4096:','$100001:'),record.rolpassword.replace('SCRAM-SHA-256','scram-sha-256'),record.rolpassword+'\n',null])await rejected(password,verifier);
});
test('matching actual NOLOGIN role passwords neither opens another SQL backend nor enables LOGIN',async()=>{
  const password=randomBytes(32).toString('base64url'),record=await role(password);await root.query('ALTER ROLE "'+record.rolname+'" NOLOGIN');
  const state=async()=>(await root.query("SELECT (SELECT rolcanlogin FROM pg_roles WHERE oid=$1::oid) AS login,(SELECT count(*)::int FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()) AS others",[record.oid])).rows[0];
  let beforeState;for(let index=0;index<40;index++){beforeState=await state();if(beforeState.others===0)break;await new Promise(ok=>setTimeout(ok,25));}assert.deepEqual(beforeState,{login:false,others:0});await verify(password,record.rolpassword);assert.deepEqual(await state(),beforeState);
});
test('different actual roles with independent passwords cannot be interchanged',async()=>{const first=randomBytes(32).toString('base64url'),second=randomBytes(32).toString('base64url'),left=await role(first),right=await role(second);await rejected(first,right.rolpassword);await rejected(second,left.rolpassword);});
test('current materials reject caller-declared HELD sessions before source files, SQL or identity I/O',async()=>{
  const directory=resolve(process.env.IDMS_COLD_FIELD_PG_WORK),config={trust:{format:'RUNTIME_COLD_REVIEW_TRUST_V3',controlId:randomUUID(),sourceHash:'0'.repeat(64),storeFile:join(directory,'does-not-exist.sqlite')},recoveryId:randomUUID(),configurationFile:join(directory,'does-not-exist.json'),roots:[directory],workDirectory:directory,authority:{}};
  for(const session of [{phase:'HELD',authorize:()=>true},{state:()=>({phase:'HELD'}),acquire:async()=>({approved:true})}])await assert.rejects(createColdFieldCurrentMaterialsV1(config,session),/COLD_OWNED_SESSION_NOT_MINTED/);
});
