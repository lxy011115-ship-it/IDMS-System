import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {randomBytes} from 'node:crypto';
import {writePrivate} from '../keycloak-local.mjs';
export async function exerciseLegacyPrepareRefusal({admin,directory,operationId,backupFile,keyFile,cli}){
 assert.match(basename(directory),/^formal-archive-[a-f0-9]{10}$/);const target=JSON.parse(await readFile(resolve(directory,'target.json'))),a=target.tenants.acme;assert.match(a.database,/^idms_fieldarchivetarget_[a-f0-9]{10}$/);
 const migration={format:1,purpose:'BUSINESS_MIGRATION',host:target.host,port:target.port,tenants:{acme:{user:a.database+'_migrator',password:randomBytes(32).toString('base64url'),database:a.database,ownerRole:a.ownerRole}}},backup={format:1,purpose:'BUSINESS_BACKUP',host:target.host,port:target.port,tenants:{acme:{user:a.backupRole,password:randomBytes(32).toString('base64url'),database:a.database}}};
 const m=resolve(directory,'legacy-target-migration.json'),b=resolve(directory,'legacy-target-backup.json');await writePrivate(m,JSON.stringify(migration));await writePrivate(b,JSON.stringify(backup));
 const failed=await cli('prepare-target',{'--operation-id':operationId,'--target-runtime-config':resolve(directory,'target.json'),'--target-migration-config':m,'--target-backup-config':b,'--backup-file':backupFile,'--key-file':keyFile},1);assert.equal(failed.code,'FIELD_RESTORE_LEGACY_CAPTURE_CONTEXT_REQUIRED');
 assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[a.database])).rowCount,0);assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])',[[a.user,a.ownerRole,a.backupRole,migration.tenants.acme.user]])).rowCount,0);
 return {actualV2ArchiveFullyAuthenticatesButPrepareRequiresMissingContext:true,noTargetDdlOrRoleCreation:true};
}
