import type pg from 'pg';
import type {TemplateVersion} from './domain.ts';
import {qualityPolicyHistory,qualityPolicyIntegrity} from './quality-policy-history.ts';
import type {PublicationEvidence} from './template-history.ts';
import {streamRows} from './pg-row-stream.ts';
import {coverageCount} from './plan-coverage.ts';
import {replayQuery,replayDeviceAccessSql} from './coverage-replay-sql.ts';
import {replayInputsSqlV2} from './coverage-replay-sql-v2.ts';
import {qualityEvaluationPackageV2} from './quality-policy-evaluation-v2.ts';
import {requireAccess,type AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import {accountValue,requestSignal,CapacityError,sqlScheduler,memoryTask} from './capacity.ts';
const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
import {sqlQualityPolicy} from './quality-policy-sql.ts';
export async function qualityPolicySqlReadV2(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,exporting:boolean,verify:(c:pg.PoolClient)=>Promise<void>,now=Date.now()){
 requireAccess(ctx,'read');const q=replayQuery(params,now);
 return sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const client=await pool.connect();try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verify(client);await replayDeviceAccessSql(client,ctx,q.device);const input=await replayInputsSqlV2(client,ctx,q),policy=await sqlQualityPolicy(client,ctx.tenantId,q.device,q.knownAt!),pack=qualityEvaluationPackageV2(input,policy);accountValue(policy);accountValue(pack);check();
  const result=exporting?pack:{...pack.result,items:pack.result.items.slice((q.page-1)*q.pageSize,q.page*q.pageSize),page:q.page,pageSize:q.pageSize,inputRecordCount:input.imports.length+input.telemetry.length,inputDigest:pack.inputDigest,policyDigest:pack.policyDigest,resultDigest:pack.resultDigest,verificationScope:'FULL_BUSINESS_HISTORY_REGISTRY_AND_APPROVED_QUALITY_POLICY',persistentApprovalReport:false};accountValue(result);check();await client.query('COMMIT');return result;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});if(e instanceof DomainError)throw e;throw qualityPolicyIntegrity();}finally{client.release();}},true),requestSignal());
}
