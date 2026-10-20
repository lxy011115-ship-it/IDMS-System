import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {canonical} from '../../server/imports.ts';
import {writePrivate} from '../keycloak-local.mjs';
import {readMaintenanceJson} from '../field-maintenance-record.mjs';
import {readFieldMaintenance} from '../field-maintenance-reader.mjs';
import {closeSourceConnection} from '../field-source-freeze.mjs';
import {exerciseFieldMaintenanceHttp} from './field-maintenance-http-checks.mjs';
import {exerciseFieldMaintenanceDrift} from './field-maintenance-drift-checks.mjs';
export async function exerciseFieldMaintenanceCore({authority,target,args,cli}){
 const directory=dirname(args['--target-runtime-config']);assert.match(basename(directory),/^formal-archive-[a-f0-9]{10}$/);assert.match(target.database,/^idms_fieldarchivetarget_[a-f0-9]{10}$/);
 const server=net.createServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const port=server.address().port;await new Promise(ok=>server.close(ok));
 const authFile=resolve(directory,'maintenance-auth.json'),auth={mode:'oidc',issuer:'http://127.0.0.1:8081/realms/idms',audience:'idms-api',clientId:'idms-recovery-qa-'+randomUUID().replaceAll('-','').slice(0,10),origin:'http://127.0.0.1:'+port};await writePrivate(authFile,JSON.stringify(auth));
 const connect=async()=>{const c=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:target.database});await c.connect();return c;};
 const image=async()=>{const c=await connect();try{return canonical({root:(await c.query('SELECT * FROM public.business_state')).rows,audits:(await c.query('SELECT * FROM public.audit_ledger ORDER BY sequence_no')).rows,sequence:(await c.query('SELECT last_value::text,is_called FROM public.audit_ledger_sequence_no_seq')).rows});}finally{await closeSourceConnection(c);}};
 const before=await image(),prepared=await cli('prepare-maintenance',{...args,'--auth-config':authFile,'--output-directory':directory});assert.equal(prepared.state,'RESTORING');assert.equal(prepared.fieldEnabled,false);assert.equal(prepared.businessWritesEnabled,false);assert.equal(await image(),before);
 const config=await readMaintenanceJson(prepared.configFile),cap=await readMaintenanceJson(prepared.capabilityFile);assert.equal(config.reader.user,target.backupRole);assert.ok(!Object.hasOwn(config,'authority')&&!Object.hasOwn(config,'bootstrapPassword'));
 const first=await readFieldMaintenance(cap,config);assert.equal(first.state,'RESTORING');assert.equal(first.relations.length,35);assert.equal(first.relations.find(r=>r.schema==='idms_field'&&r.table==='points').rows,2);assert.equal(first.relations.find(r=>r.schema==='idms_field'&&r.table==='receipts').rows,2);assert.equal(first.independentApproval,'PENDING');
 const repeat=await readFieldMaintenance(cap,config);assert.equal(repeat.verified.factsSha256,first.verified.factsSha256);assert.equal(await image(),before);
 const backup=new pg.Client({...config.reader});try{await backup.connect();for(const sql of ['INSERT INTO public.business_state(tenant_id,revision,schema_version,payload_digest) VALUES(\'unowned\',1,3,\'x\')','SELECT nextval(\'public.audit_ledger_sequence_no_seq\')','SET ROLE "'+target.ownerRole+'"'])await assert.rejects(backup.query(sql),e=>e.code==='42501');}finally{await closeSourceConnection(backup);}
 const http=await exerciseFieldMaintenanceHttp({prepared,cap,config,auth}),drift=await exerciseFieldMaintenanceDrift({authority,target,cap,config});assert.equal(await image(),before);return {prepared,cap,config,authFile,auth,proof:{actualPrepareMaintenanceCli:true,actualTwoReadonlyBackupSessionsSameSnapshot:true,actualCatalogAndFull35RelationFactsMatched:true,actualBackupInsertNextvalAndSetRoleRefused:true,targetRootAuditAndSequenceUnchanged:true,onlyBackupCredentialSupplied:true,fieldAndBusinessWritesRemainClosed:true,independentApprovalStillPending:true,http,drift}};
}
