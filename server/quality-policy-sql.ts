import type pg from 'pg';
import type {TemplateVersion} from './domain.ts';
import {qualityPolicyHistory,qualityPolicyIntegrity} from './quality-policy-history.ts';
import type {PublicationEvidence} from './template-history.ts';
import {streamRows} from './pg-row-stream.ts';
import {coverageCount} from './plan-coverage.ts';
import {replayQuery,replayDeviceAccessSql,replayInputsSql} from './coverage-replay-sql.ts';
import {qualityEvaluationPackage} from './quality-policy-evaluation.ts';
import {requireAccess,type AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import {accountValue,requestSignal,CapacityError,sqlScheduler,memoryTask} from './capacity.ts';
const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
export async function sqlQualityPolicy(client:pg.PoolClient,tenant:string,device:string,knownAt:number){
 const where="t.tenant_id=$1 AND t.body->'manifest'->>'purpose'='data-quality-policy' AND t.body->>'status' IN ('PUBLISHED','RETIRED') AND t.body->'manifest'->'dataQualityPolicy'->>'deviceCode'=$2",values=[tenant,device],templates:TemplateVersion[]=[],evidence=new Map<string,PublicationEvidence>();
 const head=(await client.query(`/* IDMS_QUALITY_POLICY_HEAD */ SELECT count(*)::text AS count FROM business_templates t WHERE ${where}`,values)).rows;check();if(head.length!==1)throw qualityPolicyIntegrity();const expected=coverageCount(head[0].count);
 await streamRows<any>(client,`/* IDMS_QUALITY_POLICY_ROWS */ SELECT t.tenant_id,t.id,t.body,a.event AS anchor,p.event AS approval,p.count AS approval_count FROM business_templates t LEFT JOIN LATERAL(SELECT event FROM audit_ledger WHERE tenant_id=t.tenant_id AND event->>'objectType'='TEMPLATE' AND event->>'objectId'=t.id ORDER BY sequence_no DESC LIMIT 1)a ON true LEFT JOIN LATERAL(SELECT count(*)::text AS count,(jsonb_agg(event ORDER BY sequence_no)->0) AS event FROM audit_ledger WHERE tenant_id=t.tenant_id AND event->>'objectType'='TEMPLATE' AND event->>'objectId'=t.id AND event->>'action'='TEMPLATE_APPROVED')p ON true WHERE ${where} ORDER BY t.ordinal`,row=>{
  check();accountValue(row);if(row.tenant_id!==tenant||row.id!==row.body?.id||row.body.tenantId!==tenant||row.body.manifest?.purpose!=='data-quality-policy'||row.body.manifest.dataQualityPolicy?.deviceCode!==device||evidence.has(row.id))throw qualityPolicyIntegrity();templates.push(row.body);evidence.set(row.id,{anchor:row.anchor||undefined,approval:row.approval||undefined,approvalCount:coverageCount(row.approval_count)});
 },()=>{templates.length=0;evidence.clear();},values);check();if(templates.length!==expected)throw qualityPolicyIntegrity();return qualityPolicyHistory(templates,tenant,device,knownAt,id=>evidence.get(id));
}
export async function qualityPolicySqlRead(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,exporting:boolean,verify:(c:pg.PoolClient)=>Promise<void>,now=Date.now()){
 requireAccess(ctx,'read');const q=replayQuery(params,now);
 return sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const client=await pool.connect();try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verify(client);await replayDeviceAccessSql(client,ctx,q.device);const input=await replayInputsSql(client,ctx,q),policy=await sqlQualityPolicy(client,ctx.tenantId,q.device,q.knownAt!),pack=qualityEvaluationPackage(input,policy);accountValue(policy);accountValue(pack);check();
  const result=exporting?pack:{...pack.result,items:pack.result.items.slice((q.page-1)*q.pageSize,q.page*q.pageSize),page:q.page,pageSize:q.pageSize,inputRecordCount:input.imports.length+input.telemetry.length,inputDigest:pack.inputDigest,policyDigest:pack.policyDigest,resultDigest:pack.resultDigest,verificationScope:'FULL_BUSINESS_HISTORY_REGISTRY_AND_APPROVED_QUALITY_POLICY',persistentApprovalReport:false};accountValue(result);check();await client.query('COMMIT');return result;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});if(e instanceof DomainError)throw e;throw qualityPolicyIntegrity();}finally{client.release();}},true),requestSignal());
}
