import pg from 'pg';
import {canonical} from '../server/imports.ts';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
import {verifyColdRegistrationJobSqlV2} from './cold-registration-job-sql-v2-request-file-v1.mjs';
import {verifyColdRegistrationMapProgramPrivilegesV1} from './cold-registration-map-program-privileges-v1.mjs';
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};

/** Retains the complete original queue/crypto verifier and adds current program
 * privileges in that same original transaction. It never commits or opens SQL. */
export async function verifyColdRegistrationJobSqlV3(client,options){
  need(client instanceof pg.Client&&client.getTransactionStatus()==='T'&&options&&Object.getPrototypeOf(options)===Object.prototype&&Object.keys(options).sort().join(',')==='baseline,members,originalInventory,roleResponsibilities,source,sourceHash,targetDirectory','COLD_REGISTRATION_JOB_PROGRAM_CONTEXT');
  const {source,sourceHash,roleResponsibilities,...baseOptions}=options;
  need(hash(source)===sourceHash&&canonical(source.inventory)===canonical(baseOptions.originalInventory),'COLD_REGISTRATION_JOB_PROGRAM_SOURCE');
  const original=await verifyColdRegistrationJobSqlV2(client,baseOptions),programPrivileges=await verifyColdRegistrationMapProgramPrivilegesV1(client,{source,sourceHash,roleResponsibilities,targetDirectory:baseOptions.targetDirectory,databaseOid:baseOptions.baseline.identity.databaseOid});
  const {sha256:baseQueueSqlEvidenceSha256,...body}=original,result={...body,format:'COLD_REGISTRATION_JOB_SQL_EVIDENCE_V3',baseQueueSqlEvidenceSha256,programPrivileges,actualRegisteredMapProgramPrivilegesVerified:true,fullRegisteredRoleMatrixVerified:false};return{...result,sha256:hash(result)};
}
