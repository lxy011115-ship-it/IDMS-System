import {quoteIdentifier as q} from '../server/postgres-schema.ts';
import {verifyDatabaseSecurity} from '../server/postgres-security.ts';
import {verifyFieldModule} from '../server/field-schema-check.ts';
import {sourceSecurityFrame} from './field-source-freeze-security.mjs';
import {sourceRuntimePrivileges,sourceFreezeError} from './field-source-freeze-policy.mjs';

// Only stages catalog changes in the caller's transaction. Its COMMIT belongs
// to the activation coordinator, after durable file publication and final checks.
export async function stageFieldRuntimePrivileges(client,account,migrator,tenantId){
 if(client.getTransactionStatus?.()!=='T')throw sourceFreezeError('FIELD_ACTIVATION_TRANSACTION_REQUIRED');
 const identity=(await client.query('SELECT session_user::text AS session_user,current_user::text AS current_user')).rows[0];
 if(identity.session_user!=='idms_bootstrap'||identity.current_user!=='idms_bootstrap')throw sourceFreezeError('FIELD_ACTIVATION_AUTHORITY_REQUIRED');
 const frozen=await sourceSecurityFrame(client,account,migrator,'FROZEN');
 await client.query(`ALTER ROLE ${q(account.user)} LOGIN;ALTER ROLE ${q(migrator)} LOGIN;GRANT ${q(account.ownerRole)} TO ${q(migrator)} WITH INHERIT FALSE, SET TRUE;SET LOCAL ROLE ${q(account.ownerRole)}`);
 for(const r of sourceRuntimePrivileges(account))await client.query(`GRANT ${r.privileges.join(',')} ON TABLE ${q(r.schema)}.${q(r.table)} TO ${q(account.user)}`);
 await client.query(`GRANT USAGE ON SEQUENCE public.audit_ledger_sequence_no_seq TO ${q(account.user)};SET LOCAL ROLE ${q(account.user)}`);
 await verifyDatabaseSecurity(client,account,tenantId);
 await verifyFieldModule(client,account,tenantId);
 await client.query('SET LOCAL ROLE idms_bootstrap');
 const runtime=await sourceSecurityFrame(client,account,migrator,'RUNTIME');
 if(JSON.stringify(runtime)!==JSON.stringify(frozen))throw sourceFreezeError('FIELD_ACTIVATION_ROLE_BINDING_CHANGED');
 return runtime;
}
