import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {sparesSchema,sparesHistorySchema,verifySparesDatabase} from '../server/spares-db.ts';
import {sparesCapacitySchema} from '../server/spares-capacity-schema.ts';
const config=JSON.parse(await readFile('.local/postgres-migration.json','utf8'));
const business=JSON.parse(await readFile('.local/postgres-business.json','utf8'));
if(config.purpose!=='BUSINESS_MIGRATION')throw Error('Dedicated migration configuration required');
const q=s=>{if(!/^[a-z_][a-z0-9_]{0,62}$/.test(s))throw Error('Invalid role');return '"'+s+'"';};
for(const [tenant,a] of Object.entries(config.tenants)){
 const runtime=business.tenants[tenant];if(!runtime||runtime.database!==a.database)throw Error('Tenant binding mismatch');
 const c=new pg.Client({host:config.host,port:config.port,user:a.user,password:a.password,database:a.database});await c.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE '+q(a.ownerRole||runtime.ownerRole));const found=(await c.query("SELECT to_regclass('idms_spares.state') AS relation")).rows[0]?.relation;if(!found){await c.query(sparesSchema);await c.query('INSERT INTO idms_spares.state(tenant_id) VALUES($1)',[tenant]);}
 await c.query("SET LOCAL lock_timeout='5s'");await c.query("SET LOCAL statement_timeout='120s'");await c.query('SELECT revision FROM idms_spares.state WHERE tenant_id=$1 FOR UPDATE',[tenant]);await c.query(sparesHistorySchema);await verifySparesDatabase(c,tenant);await c.query(sparesCapacitySchema);await c.query('REVOKE ALL ON SCHEMA idms_spares FROM PUBLIC');await c.query('GRANT USAGE ON SCHEMA idms_spares TO '+q(runtime.user)+','+q(runtime.backupRole));await c.query('REVOKE ALL ON ALL TABLES IN SCHEMA idms_spares FROM PUBLIC');await c.query('GRANT SELECT ON idms_spares.migrations TO '+q(runtime.user));await c.query('GRANT SELECT,UPDATE ON idms_spares.state TO '+q(runtime.user));await c.query('GRANT SELECT,INSERT,UPDATE ON idms_spares.entities TO '+q(runtime.user));await c.query('GRANT SELECT,INSERT ON idms_spares.events,idms_spares.receipts TO '+q(runtime.user));await c.query('GRANT SELECT ON ALL TABLES IN SCHEMA idms_spares TO '+q(runtime.backupRole));await c.query('COMMIT');console.log(tenant+': spares schema ready; existing public business data untouched');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}
}
