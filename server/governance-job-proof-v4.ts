import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import {DomainMapSnapshot,domainMapAssert as need} from './domain-map-v4.ts';
import {PostgresStateBranchV1} from './state-map-branch-v1.ts';
import {canonicalEqual,canonicalDigest} from './canonical-state.ts';
import type {GovernanceJobV4} from './governance-job-store-v4.ts';
import type {GovernanceCommandV4} from './governance-plan-v4.ts';
export function verifyGovernanceJobCommandV4(job:GovernanceJobV4,command:GovernanceCommandV4){need(command.action===job.action&&canonicalDigest(command)===job.requestHash,'GOVERNANCE_JOB_COMMAND_INTEGRITY');return command;}
/** Bounded completion proof. Current scope must be checked by caller before revealing it. */
export async function verifyGovernanceJobCompletionV4(account:ClientConfig,binding:StateMapBinding,job:GovernanceJobV4){
 const s=await DomainMapSnapshot.open(account,binding);let value:any;try{const v=await s.state('receipt','governance_command:'+job.businessKey);if(!v.present){need(!['COMMITTED','FAILED','CANCELLED'].includes(job.status),'GOVERNANCE_JOB_COMPLETION_MISSING');return null;}value=v.value;need(value?.format==='IDMS_GOVERNANCE_COMMAND_V4_1'&&value.key===job.businessKey&&value.requestHash===job.requestHash,'GOVERNANCE_JOB_COMPLETION_INTEGRITY');}finally{await s.close();}
 if(value.status==='COMMITTED'){const branches=new PostgresStateBranchV1(account,binding),b=await branches.read(value.branchId);need(b.publishedCommandId===value.publicationId&&await branches.resolvePublication(b,value.publicationId),'GOVERNANCE_JOB_PUBLICATION_INTEGRITY');if(job.status==='COMMITTED')need(job.publicationId===value.publicationId&&canonicalEqual(job.result,value.result),'GOVERNANCE_JOB_RESULT_INTEGRITY');}
 else need(value.status==='FAILED'&&Number.isInteger(value.error?.status)&&typeof value.error?.message==='string','GOVERNANCE_JOB_FAILURE_INTEGRITY');
 if(['FAILED','CANCELLED'].includes(job.status))need(value.status==='FAILED'&&(job.status!=='CANCELLED'||value.error.message==='GOVERNANCE_JOB_CANCELLED'),'GOVERNANCE_JOB_TERMINAL_INTEGRITY');if(job.status==='COMMITTED')need(value.status==='COMMITTED','GOVERNANCE_JOB_TERMINAL_INTEGRITY');return value;
}
