import pg from 'pg';
import {canonical} from '../server/imports.ts';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
import {verifyColdRegistrationAuthSqlV1} from './cold-registration-auth-sql-v1-request-file-v1.mjs';
import {verifyColdRegistrationAuthProgramPrivilegesV1} from './cold-registration-auth-program-privileges-v1.mjs';
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};

/** The frozen V1 decrypts every original session/login row and restores root.
 * Current auth program privileges then run in that SAME caller transaction.
 * No new connection, window, ordinary login, write, business call or COMMIT. */
export async function verifyColdRegistrationAuthSqlV2(client,options){
 need(client instanceof pg.Client&&client.getTransactionStatus()==='T'&&options&&Object.getPrototypeOf(options)===Object.prototype&&Object.keys(options).sort().join(',')==='baseline,originalInventory,ring,roleResponsibilities,runtime,source,sourceHash,targetDirectory','COLD_REGISTRATION_AUTH_PROGRAM_CONTEXT');
 const {source,sourceHash,roleResponsibilities,...originalOptions}=options;
 need(hash(source)===sourceHash&&canonical(source.inventory)===canonical(originalOptions.originalInventory),'COLD_REGISTRATION_AUTH_PROGRAM_SOURCE');
 const original=await verifyColdRegistrationAuthSqlV1(client,originalOptions);
 const programPrivileges=await verifyColdRegistrationAuthProgramPrivilegesV1(client,{source,sourceHash,roleResponsibilities,runtime:originalOptions.runtime,targetDirectory:originalOptions.targetDirectory,databaseOid:originalOptions.baseline.identity.databaseOid});
 const {sha256:baseAuthenticationSqlEvidenceSha256,...body}=original;
 const result={...body,format:'COLD_REGISTRATION_AUTH_SQL_EVIDENCE_V2',baseAuthenticationSqlEvidenceSha256,programPrivileges,actualRegisteredAuthProgramPrivilegesVerified:true,fullRegisteredRoleMatrixVerified:false};
 return{...result,sha256:hash(result)};
}
