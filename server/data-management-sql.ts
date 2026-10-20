import {sqlScheduler,memoryTask,requestSignal} from './capacity.ts';
import {currentQuery} from './revision-projection.ts';
import type pg from 'pg';
import {requireAccess,scopeFilter,scopeAllows,type AccessContext} from './access.ts';
import {overviewQuery,measurementQuery,overviewNotice,measurementNotice,exportWindow} from './data-management.ts';
import {approvedPoint} from './point-definitions.ts';
import {emptyImports} from './imports.ts';

const source=(r:pg.QueryResultRow)=>({batchId:r.batch_id,sourceSystem:r.source_system,sourceRow:r.source_row,sourceRecordId:r.body.source_record_id,snapshotDigest:r.snapshot_digest,recordVersion:r.record_version,supersedesBatchId:r.previous_batch_id||null});
function scopeSql(ctx:AccessContext, start:number){
  const f=scopeFilter(ctx),parts:string[]=[],values:unknown[]=[];let n=start;
  if(f.sites!==null){parts.push(`a.site_code=ANY($${n}::text[])`);values.push(f.sites);n++;}
  if(f.lines!==null){parts.push(`a.line_code=ANY($${n}::text[])`);values.push(f.lines);n++;}
  if(f.devices!==null){parts.push(`a.device_code=ANY($${n}::text[])`);values.push(f.devices);n++;}
  return {clause:parts.length?' AND '+parts.join(' AND '):'',values};
}

export const assetSqlItem=(r:pg.QueryResultRow)=>({asset:r.body,source:source(r),definedPoints:Number(r.points),measurements:Number(r.measurements)});
export const measurementSqlItem=(r:pg.QueryResultRow,tenant:string)=>({measurement:r.body,source:source(r),definition:r.definition||approvedPoint(emptyImports(),tenant,String(r.body.device_code),String(r.body.tag_code))||null});
export function assetRowsSql(ctx:AccessContext,params:URLSearchParams){
 const q=overviewQuery(params);
    const values=[ctx.tenantId,q.type||null,q.site||null,q.search||null],scope=scopeSql(ctx,5);
    const where=`a.tenant_id=$1 AND ($2::text IS NULL OR COALESCE(a.equipment_type,'未分类')=$2) AND ($3::text IS NULL OR a.site_code=$3) AND
      ($4::text IS NULL OR strpos(lower(a.device_code),$4)>0 OR strpos(lower(a.device_name),$4)>0 OR strpos(lower(COALESCE(a.equipment_type,'')),$4)>0 OR strpos(lower(COALESCE(a.brand,'')),$4)>0 OR strpos(lower(COALESCE(a.model,'')),$4)>0)${scope.clause}`;
    const scopedValues=[...values,...scope.values];
 return {q,where,values:scopedValues,text:`SELECT a.*,a.site_code AS asset_site_code,a.line_code AS asset_line_code,a.device_code AS asset_device_code,COALESCE(p.points,0) AS points,COALESCE(m.measurements,0) AS measurements
      FROM current_assets a
      LEFT JOIN (SELECT tenant_id,device_code,count(*) AS points FROM current_point_definitions GROUP BY tenant_id,device_code) p ON p.tenant_id=a.tenant_id AND p.device_code=a.device_code
      LEFT JOIN (SELECT tenant_id,device_code,count(*) AS measurements FROM current_measurements GROUP BY tenant_id,device_code) m ON m.tenant_id=a.tenant_id AND m.device_code=a.device_code
      WHERE ${where} ORDER BY a.source_ordinal`};
}
export function measurementRowsSql(ctx:AccessContext,params:URLSearchParams){
 const q=measurementQuery(params);
    const values=[ctx.tenantId,q.device||null,q.tag||null,q.quality||null,q.from===null?null:new Date(q.from).toISOString(),q.to===null?null:new Date(q.to).toISOString()],scope=scopeSql(ctx,7),scopedValues=[...values,...scope.values];
    const where=`m.tenant_id=$1 AND ($2::text IS NULL OR m.device_code=$2) AND ($3::text IS NULL OR m.tag_code=$3) AND ($4::text IS NULL OR m.quality=$4) AND ($5::timestamptz IS NULL OR m.measured_at>=$5) AND ($6::timestamptz IS NULL OR m.measured_at<=$6)${scope.clause}`;
 return {q,where,values:scopedValues,text:`SELECT m.*,a.site_code AS asset_site_code,a.line_code AS asset_line_code,a.device_code AS asset_device_code,CASE WHEN p.source_ordinal IS NULL THEN NULL ELSE jsonb_build_object('label',p.tag_name,'unit',p.unit,'min',p.min_value,'max',p.max_value,'definitionBatchId',p.batch_id,'expectedIntervalSeconds',p.expected_interval_seconds,'origin','APPROVED_DEFINITION') END AS definition
      FROM current_measurements m
      JOIN current_assets a ON a.tenant_id=m.tenant_id AND a.device_code=m.device_code
      LEFT JOIN current_point_definitions p ON p.tenant_id=m.tenant_id AND p.device_code=m.device_code AND p.tag_code=m.tag_code
      WHERE ${where} ORDER BY m.measured_at DESC,m.batch_id,m.source_row,m.source_ordinal`};
}

export function validateExportRow(row:pg.QueryResultRow,ctx:AccessContext,assets:boolean){
 if(!row||row.tenant_id!==ctx.tenantId||!row.body||typeof row.body!=='object'||Array.isArray(row.body)||row.data_type!==(assets?'DEVICE':'MEASUREMENT')||typeof row.batch_id!=='string'||typeof row.source_system!=='string'||!Number.isSafeInteger(row.source_row)||row.source_row<1||typeof row.snapshot_digest!=='string'||!/^[a-f0-9]{64}$/.test(row.snapshot_digest)||!Number.isSafeInteger(row.record_version)||row.record_version<1||typeof row.asset_site_code!=='string'||typeof row.asset_line_code!=='string'||typeof row.asset_device_code!=='string'||row.device_code!==row.asset_device_code||String(row.body.device_code)!==row.device_code||!scopeAllows(ctx,{site_code:row.asset_site_code,line_code:row.asset_line_code,device_code:row.asset_device_code})||assets&&(String(row.body.site_code)!==row.asset_site_code||String(row.body.line_code)!==row.asset_line_code))throw Error('Export row binding or authorization mismatch');
}

type ReadGuard=(client:pg.PoolClient)=>Promise<void>;
async function readView<T>(pool:pg.Pool,ctx:AccessContext,work:(client:pg.PoolClient)=>Promise<T>,verify?:ReadGuard){
  requireAccess(ctx,'read');return sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const client=await pool.connect();
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verify?.(client);const result=await work(client);await client.query('COMMIT');return result;}
  catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
 },true),requestSignal());
}
export async function dataOverviewSql(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,exportAll=false,verify?:ReadGuard){
  const q=overviewQuery(params);
  return readView(pool,ctx,async client=>{
    const selected=assetRowsSql(ctx,params),scopedValues=selected.values,where=selected.where,scope=scopeSql(ctx,5);
    const total=Number((await currentQuery(client,`SELECT count(*) FROM current_assets a WHERE ${where}`,scopedValues)).rows[0].count);
    exportWindow(q,total,exportAll);
    const rows=(await currentQuery(client,selected.text+` LIMIT $${5+scope.values.length} OFFSET $${6+scope.values.length}`,[...scopedValues,q.pageSize,(q.page-1)*q.pageSize])).rows;
    const visible=scopeSql(ctx,2),visibleValues=[ctx.tenantId,...visible.values];
    const summary=(await currentQuery(client,`SELECT
      (SELECT count(*) FROM current_assets a WHERE a.tenant_id=$1${visible.clause}) AS devices,
      (SELECT count(*) FROM current_point_definitions p JOIN current_assets a ON a.tenant_id=p.tenant_id AND a.device_code=p.device_code WHERE p.tenant_id=$1${visible.clause}) AS points,
      (SELECT count(*) FROM current_measurements m JOIN current_assets a ON a.tenant_id=m.tenant_id AND a.device_code=m.device_code WHERE m.tenant_id=$1${visible.clause}) AS measurements,
      (SELECT count(*) FROM current_measurements m JOIN current_assets a ON a.tenant_id=m.tenant_id AND a.device_code=m.device_code WHERE m.tenant_id=$1 AND m.quality<>'GOOD'${visible.clause}) AS non_good`,visibleValues)).rows[0];
    const types=(await currentQuery(client,`SELECT DISTINCT COALESCE(a.equipment_type,'未分类') AS type FROM current_assets a WHERE a.tenant_id=$1${visible.clause}`,visibleValues)).rows;
    const sites=(await currentQuery(client,`SELECT DISTINCT a.site_code FROM current_assets a WHERE a.tenant_id=$1${visible.clause}`,visibleValues)).rows;
    return {items:rows.map(assetSqlItem),total,page:q.page,pageSize:q.pageSize,summary:{devices:Number(summary.devices),definedPoints:Number(summary.points),measurements:Number(summary.measurements),nonGoodMeasurements:Number(summary.non_good)},equipmentTypes:types.map(r=>r.type).sort(),sites:sites.map(r=>r.site_code).sort(),notice:overviewNotice};
  },verify);
}
export async function dataMeasurementsSql(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,exportAll=false,verify?:ReadGuard){
  const q=measurementQuery(params);
  return readView(pool,ctx,async client=>{
    const selected=measurementRowsSql(ctx,params),scopedValues=selected.values,where=selected.where,scope=scopeSql(ctx,7);
    const total=Number((await currentQuery(client,`SELECT count(*) FROM current_measurements m JOIN current_assets a ON a.tenant_id=m.tenant_id AND a.device_code=m.device_code WHERE ${where}`,scopedValues)).rows[0].count);
    exportWindow(q,total,exportAll);
    const rows=(await currentQuery(client,selected.text+` LIMIT $${7+scope.values.length} OFFSET $${8+scope.values.length}`,[...scopedValues,q.pageSize,(q.page-1)*q.pageSize])).rows;
    const latest=(await currentQuery(client,`SELECT m.body->>'measured_at' AS time FROM current_measurements m JOIN current_assets a ON a.tenant_id=m.tenant_id AND a.device_code=m.device_code WHERE ${where} ORDER BY m.measured_at DESC,m.batch_id,m.source_row LIMIT 1`,scopedValues)).rows[0]?.time||null;
    const definitionScope=scopeSql(ctx,4);
    const definitions=(await currentQuery(client,`SELECT p.* FROM current_point_definitions p JOIN current_assets a ON a.tenant_id=p.tenant_id AND a.device_code=p.device_code WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.device_code=$2) AND ($3::text IS NULL OR p.tag_code=$3)${definitionScope.clause} ORDER BY p.source_ordinal LIMIT 100`,[ctx.tenantId,q.device||null,q.tag||null,...definitionScope.values])).rows;
    return {items:rows.map(r=>measurementSqlItem(r,ctx.tenantId)),total,page:q.page,pageSize:q.pageSize,dataAsOf:latest,definitions:definitions.map(r=>({point:r.body,source:source(r)})),notice:measurementNotice};
  },verify);
}
