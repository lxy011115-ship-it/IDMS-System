import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {randomBytes} from 'node:crypto';
import {quoteIdentifier as q} from '../../server/postgres-schema.ts';
import {canonical} from '../../server/imports.ts';
import {writePrivate} from '../keycloak-local.mjs';
const literal=s=>"E'"+s.replaceAll('\\','\\\\').replaceAll("'","''")+"'";
function owned(directory,target){assert.match(basename(directory),/^formal-archive-[a-f0-9]{10}$/);assert.match(target.database,/^idms_fieldarchivetarget_[a-f0-9]{10}$/);}
export async function beforePrepareNegatives({admin,directory,target,args,cli}){
 owned(directory,target);const absent=async()=>{assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[target.database])).rowCount,0);assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])',[[target.user,target.ownerRole,target.backupRole,target.database+'_migrator']])).rowCount,0);};await absent();
 assert.equal((await cli('prepare-target',{...args,'--key-file':resolve(directory,'other-key.json')},1)).code,'FIELD_RESTORE_ARCHIVE_KEY_CHANGED');await absent();
 let role=false;try{await admin.query(`CREATE ROLE ${q(target.user)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);role=true;const before=(await admin.query('SELECT oid::text,rolname,rolcanlogin FROM pg_roles WHERE rolname=$1',[target.user])).rows;assert.equal((await cli('prepare-target',args,1)).code,'FIELD_RESTORE_TARGET_ALREADY_EXISTS');assert.equal(canonical((await admin.query('SELECT oid::text,rolname,rolcanlogin FROM pg_roles WHERE rolname=$1',[target.user])).rows),canonical(before));}finally{if(role)await admin.query(`DROP ROLE ${q(target.user)}`);}
 let database=false;try{await admin.query(`CREATE DATABASE ${q(target.database)} TEMPLATE template0 ALLOW_CONNECTIONS false`);database=true;const before=(await admin.query('SELECT oid::text,datname,datdba::text,datallowconn FROM pg_database WHERE datname=$1',[target.database])).rows;assert.equal((await cli('prepare-target',args,1)).code,'FIELD_RESTORE_TARGET_ALREADY_EXISTS');assert.equal(canonical((await admin.query('SELECT oid::text,datname,datdba::text,datallowconn FROM pg_database WHERE datname=$1',[target.database])).rows),canonical(before));}finally{if(database)await admin.query(`DROP DATABASE ${q(target.database)}`);}
 await absent();return {wrongKeyBeforeAnyTargetDdl:true,existingRoleNotAdoptedOrChanged:true,existingDatabaseNotAdoptedOrChanged:true};
}
export async function afterPrepareNegatives({admin,directory,target,args,cli}){
 owned(directory,target);const original=JSON.parse(await readFile(args['--target-runtime-config'])),changed=structuredClone(original);changed.tenants.acme.password=randomBytes(32).toString('base64url');const file=resolve(directory,'changed-target-secret.json');await writePrivate(file,JSON.stringify(changed));assert.equal((await cli('prepare-target',{...args,'--target-runtime-config':file},1)).code,'FIELD_RESTORE_CONFIG_CHANGED');
 const roleFile=resolve(directory,'recovery.json.operations',args['--operation-id']+'.restore-roles.json'),bytes=await readFile(roleFile);
 try{const corrupt=JSON.parse(bytes);corrupt.roles.owner.oid='1';await writeFile(roleFile,canonical(corrupt));assert.equal((await cli('prepare-target',args,1)).code,'FIELD_RESTORE_RECORD_INVALID');}finally{await writeFile(roleFile,bytes);}
 const comment=(await admin.query("SELECT shobj_description(oid,'pg_authid') AS comment FROM pg_roles WHERE rolname=$1",[target.ownerRole])).rows[0].comment;assert.ok(typeof comment==='string'&&comment.startsWith('IDMS_FIELD_RESTORE_ROLE_V1\n'));
 try{await admin.query(`COMMENT ON ROLE ${q(target.ownerRole)} IS 'OWNED_QA_DRIFT'`);assert.equal((await cli('prepare-target',args,1)).code,'FIELD_RESTORE_ROLE_CAPABILITY_CHANGED');}finally{await admin.query(`COMMENT ON ROLE ${q(target.ownerRole)} IS ${literal(comment)}`);}
 return {changedTargetSecretNotResetOrAdopted:true,tamperedRoleOidJournalRefused:true,changedRoleCapabilityCommentRefused:true};
}
