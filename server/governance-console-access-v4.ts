import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import type {AccessContext} from './access.ts';
import type {GovernanceCommandV4} from './governance-plan-v4.ts';
import {governanceBasicAccessV4} from './governance-plan-v4.ts';
import {authorizeGovernanceJobV4} from './governance-job-access-v4.ts';
import {GovernanceConsoleReadV4} from './governance-console-read-v4.ts';
import {memoryAuditCursorCodec} from './audit-cursor.ts';
/** Fresh current scope, never cached authority; batch checks use the proven coverage projection. */
export async function authorizeGovernanceConsoleJobV4(account:ClientConfig,binding:StateMapBinding,command:GovernanceCommandV4,ctx:AccessContext,result?:Record<string,unknown>|null,{cancel=false}:{cancel?:boolean}={}){
 if(cancel)return authorizeGovernanceJobV4(account,binding,command,ctx,result,{cancel:true});governanceBasicAccessV4(command,ctx);
 const batchId=command.action==='IMPORT_APPROVE'?command.id:command.action==='IMPORT_CREATE'&&typeof result?.batchId==='string'?result.batchId:null;
 if(batchId){const current=await new GovernanceConsoleReadV4(account,binding,memoryAuditCursorCodec()).authorizeBatch(batchId,ctx);return {keys:current.readStats.keys,valueBytes:current.readStats.valueBytes};}
 return authorizeGovernanceJobV4(account,binding,command,ctx,result);
}
