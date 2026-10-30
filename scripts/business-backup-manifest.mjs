import {validateSparesBackupAnchor} from './spares-backup-anchor.mjs';
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const fail=()=>{throw Error('Invalid authenticated version-2 business backup manifest');};
export function validateBusinessBackupManifest(manifest){
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))fail();
 const names=['format','backupId','tenantId','createdAt','sourceDatabase','pgVersion','schemaVersion','scope','recoveryMode','excluded','facts','checks','spares','dumpSha256'];
 if(Object.keys(manifest).length!==names.length||names.some(name=>!Object.hasOwn(manifest,name))||manifest.format!==2||manifest.schemaVersion!==2||manifest.scope!=='TENANT_BUSINESS_DATABASE'||manifest.recoveryMode!=='ISOLATED_BUSINESS_ONLY')fail();
 if(typeof manifest.backupId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(manifest.backupId)||typeof manifest.tenantId!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(manifest.tenantId)||typeof manifest.createdAt!=='string'||!Number.isFinite(Date.parse(manifest.createdAt))||typeof manifest.sourceDatabase!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(manifest.sourceDatabase)||!/^16[0-9]{4}$/.test(manifest.pgVersion)||!hex(manifest.dumpSha256))fail();
 if(!Array.isArray(manifest.excluded)||manifest.excluded.length>30||manifest.excluded.some(v=>typeof v!=='string'||v.length>100)||!Array.isArray(manifest.facts)||manifest.facts.length>1000)fail();
 const tables=new Set();for(const fact of manifest.facts){if(!fact||Object.keys(fact).sort().join(',')!=='columns,rows,sha256,table'||typeof fact.table!=='string'||!fact.table||fact.table.length>256||tables.has(fact.table)||!count(fact.rows)||!hex(fact.sha256)||!Array.isArray(fact.columns)||fact.columns.length>1600)fail();tables.add(fact.table);}
 const checks=manifest.checks;if(!checks||Object.keys(checks).sort().join(',')!=='auditEvents,batches,businessDigest,importsDigest,records,workOrders'||['auditEvents','batches','records','workOrders'].some(k=>!count(checks[k]))||!hex(checks.businessDigest)||!hex(checks.importsDigest))fail();
 validateSparesBackupAnchor(manifest.spares);return manifest;
}
