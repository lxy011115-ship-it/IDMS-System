import {provisionAuthStore,cleanupQaAuthStore} from './auth-session-store.mjs';
import {roleLayout,migrateTenant,businessRuntime,backupRuntime} from './database-migrations.mjs';
import {seedStore} from '../server/store.ts';
import {emptyImports} from '../server/imports.ts';
import {canonical,digest} from '../server/imports.ts';
import {businessSchema,workflowSchema,aiSchema,telemetrySchema,migrationTableSchema,legacyMigrationChecksum,revisionMigrationChecksum} from '../server/postgres-schema.ts';
import {initializeDataProjection} from '../server/data-projection.ts';
import {tenantSeed} from './database-migrations.mjs';
import pg from 'pg';
import {readEntities,writeEntities} from '../server/entity-repository.ts';
import {projectApprovedData} from '../server/data-projection.ts';

export function qaAdminAccount(root,account){
  if(!/^idms_(qa|[a-z]+qa)_/.test(account.database))throw Error('Fault injection is restricted to generated QA databases');
  return {host:root.host,port:root.port,user:'idms_bootstrap',password:root.bootstrapPassword,database:account.database};
}
export async function migrateQaDatabases(config,root,{telemetryTenants=[],snapshot,legacyVersion}={}){
  const store=seedStore(),{audits,idempotency,...business}=store;
  const seed=snapshot||{version:2,business,audits,idempotency:[...idempotency],imports:emptyImports()};
  config.businessRoles??={};
  for(const [tenant,a]of Object.entries(config.tenants)){
    if(!/^idms_(qa|[a-z]+qa)_/.test(a.database)||a.user!==a.database)throw Error('QA migration requires its own generated database AND application role');
    config.businessRoles[tenant]??={...roleLayout(a),telemetry:telemetryTenants.includes(tenant)};
  }
  if(legacyVersion!==undefined){
    if(![1,2].includes(legacyVersion))throw Error('QA legacy fixture version must be 1 or 2');config.qaLegacyProof={};
    for(const [tenant,a]of Object.entries(config.tenants)){
      const c=new pg.Client({host:config.host,port:config.port,...a});await c.connect();
      try{
        const p=tenantSeed(seed,tenant),r=config.businessRoles[tenant];await c.query('BEGIN');await c.query(businessSchema);await c.query(workflowSchema);await c.query(aiSchema);if(r.telemetry)await c.query(telemetrySchema);
        await c.query('INSERT INTO runtime_state(singleton,revision,schema_version,payload) VALUES(true,7,2,$1)',[p]);
        for(const e of p.audits)await c.query('INSERT INTO audit_ledger(event_id,tenant_id,hash,previous_hash,event) VALUES($1,$2,$3,$4,$5)',[e.eventId,tenant,e.hash,e.previousHash,e]);
        await initializeDataProjection(c,p.imports,tenant);if(legacyVersion===1)await c.query('DROP TABLE managed_record_revisions');await c.query(migrationTableSchema);
        for(let v=1;v<=legacyVersion;v++)await c.query('INSERT INTO idms_schema_migrations(version,tenant_id,checksum,modules,owner_role,app_role,backup_role) VALUES($1,$2,$3,$4,$5,$6,$7)',[v,tenant,v===1?legacyMigrationChecksum(r.telemetry):revisionMigrationChecksum(r.telemetry),JSON.stringify(r.telemetry?['core','telemetry']:['core']),r.owner,a.user,r.backup.user]);
        config.qaLegacyProof[tenant]={migrationRows:(await c.query('SELECT * FROM idms_schema_migrations ORDER BY version')).rows,importsDigest:digest(canonical(p.imports)),businessDigest:digest(canonical(p.business)),auditDigest:digest(canonical(p.audits)),baseRowsDigest:digest(canonical((await c.query('SELECT * FROM managed_import_rows ORDER BY ordinal')).rows))};await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}
    }
  }
  const deployment={...config,bootstrapPassword:root.bootstrapPassword};
  for(const tenant of Object.keys(config.tenants))await migrateTenant(deployment,tenant,seed);
  const runtime=businessRuntime(config);config.authSessionStore=await provisionAuthStore(runtime,root,{qa:true});return runtime;
}
export async function cleanupQaRoles(admin,config){
  if(config.authSessionStore)await cleanupQaAuthStore(admin,config.authSessionStore);
  for(const [tenant,r]of Object.entries(config.businessRoles||{})){
    const a=config.tenants[tenant];
    if(!/^idms_(qa|[a-z]+qa)_/.test(a.database)||a.user!==a.database)throw Error('Invalid QA role cleanup target');
    const expected=roleLayout(a);
    if(r.owner!==expected.owner||r.migrator.user!==expected.migrator.user||r.backup.user!==expected.backup.user)throw Error('QA role ownership mismatch');
    for(const name of [r.migrator.user,r.backup.user,r.owner])await admin.query(`DROP ROLE IF EXISTS "${name}"`);
  }
}
export {backupRuntime};
export async function updateQaPayload(client,tenantId,payload){
 const name=(await client.query('SELECT current_database() AS name')).rows[0].name;if(!/^idms_(qa|[a-z]+qa)_/.test(name))throw Error('QA seed mutation is restricted to generated QA databases');
 await client.query('BEGIN');try{await client.query('SELECT revision FROM business_state WHERE tenant_id=$1 FOR UPDATE',[tenantId]);const prior=await readEntities(client,tenantId);await writeEntities(client,prior.payload,payload,tenantId);await projectApprovedData(client,payload.imports,tenantId);await client.query('UPDATE business_state SET revision=revision+1,payload_digest=$2 WHERE tenant_id=$1',[tenantId,digest(canonical(payload))]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}
}
