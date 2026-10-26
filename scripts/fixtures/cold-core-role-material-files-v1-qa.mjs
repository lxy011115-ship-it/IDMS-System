import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {canonical} from '../../server/imports.ts';
import {privateNewFile} from '../backup-support.mjs';
import {createColdRegistrationCoreMaterialQaV2} from './cold-registration-core-materials-v2-qa.mjs';
import {coldSourceConnectOnlyRoleNamesV1} from '../cold-registration-role-responsibilities-v2.mjs';

/** Capture actual delivery runtimes and retired identity declarations from this SOURCE into fresh private copies. */
export async function createColdCoreRoleMaterialFilesQaV1({directory,originalDirectory,trust}){
  const fixture=await createColdRegistrationCoreMaterialQaV2({directory,originalDirectory,trust}),original=resolve(originalDirectory),json=async file=>JSON.parse(await readFile(file,'utf8')),deliveryFiles=[],retiredFiles=[],state=fixture.state;
  let keyFile=null,keyRing=null;
  for(const tenant of fixture.declaration.components.map(value=>value.tenantId).filter((value,index,all)=>all.indexOf(value)===index).sort()){
    const sourceFile=join(original,'auth-map-source-'+tenant+'-delivery.private.json'),runtime=await json(sourceFile),ring=await json(resolve(dirname(sourceFile),runtime.keyFile));
    if(keyRing)assert.equal(canonical(ring),canonical(keyRing));else{keyRing=ring;keyFile=join(fixture.root,'authentication-delivery-key.private.json');await privateNewFile(keyFile,canonical(ring));}
    const file=join(fixture.root,'authentication-delivery-'+tenant+'.private.json');await privateNewFile(file,canonical({...runtime,keyFile}));deliveryFiles.push(file);
  }
  for(const retired of state.source.retired){
    const database=state.source.inventory.databases.find(value=>value.oid===retired.source.databaseOid),excluded=new Set([retired.source.roleOid,retired.source.ownerOid,...state.source.inventory.memberships.filter(value=>value.roleid===retired.source.ownerOid).map(value=>value.member)]),candidates=coldSourceConnectOnlyRoleNamesV1(database.datacl).map(name=>state.source.inventory.roles.find(value=>value.rolname===name)).filter(role=>role&&!excluded.has(role.oid));
    assert.equal(candidates.length,1,'QA_RETIRED_BACKUP_IDENTITY_AMBIGUOUS');
    const file=join(fixture.root,'retired-role-identities-'+database.oid+'.private.json');await privateNewFile(file,canonical({format:1,purpose:'COLD_RETIRED_DATABASE_ROLE_IDENTITIES_V1',sourceHash:trust.sourceHash,controlId:trust.controlId,databaseOid:database.oid,ownerRoleOid:retired.source.ownerOid,applicationRoleOid:retired.source.roleOid,backupRoleOid:candidates[0].oid}));retiredFiles.push(file);
  }
  await fixture.change(fixture.configurationFile,value=>{value.format=2;value.purpose='COLD_REGISTRATION_CORE_DEPLOYMENT_V2';value.authenticationDeliveryRuntimeFiles=deliveryFiles;value.retiredRoleIdentityFiles=retiredFiles;});
  return {...fixture,deliveryFiles,retiredFiles,keyFile};
}
