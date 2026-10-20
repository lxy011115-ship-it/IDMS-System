// Frozen pre-capacity SQL reference used only by the isolated comparison.
import {currentQuery} from './read-capacity-baseline-current.mjs';
import type pg from 'pg';
import {requireAccess,scopeFilter,type AccessContext} from '../../server/access.ts';
import {overviewQuery,measurementQuery,overviewNotice,measurementNotice,exportWindow} from '../../server/data-management.ts';
import {approvedPoint} from '../../server/point-definitions.ts';
import {emptyImports} from '../../server/imports.ts';

const source=(r:pg.QueryResultRow)=>({batchId:r.batch_id,sourceSystem:r.source_system,sourceRow:r.source_row,sourceRecordId:r.body.source_record_id,snapshotDigest:r.snapshot_digest,recordVersion:r.record_version,supersedesBatchId:r.previous_batch_id||null});
function scopeSql(ctx:AccessContext, start:number){
  const f=scopeFilter(ctx),parts:string[]=[],values:unknown[]=[];let n=start;
  if(f.sites!==null){parts.push(`a.site_code=ANY($${n}::text[])`);values.push(f.sites);n++;}
  if(f.lines!==null){parts.push(`a.line_code=ANY($${n}::text[])`);values.push(f.lines);n++;}
  if(f.devices!==null){parts.push(`a.device_code=ANY($${n}::text[])`);values.push(f.devices);n++;}
  return {clause:parts.length?' AND '+parts.join(' AND '):'',values};
}
async function readView<T>(pool:pg.Pool,ctx:AccessContext,work:(client:pg.PoolClient)=>Promise<T>){
  requireAccess(ctx,'read');const client=await pool.connect();
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await work(client);await client.query('COMMIT');return result;}
  catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export async function dataOverviewSql(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,exportAll=false){
  const q=overviewQuery(params);
  return readView(pool,ctx,async client=>{
    const values=[ctx.tenantId,q.type||null,q.site||null,q.search||null],scope=scopeSql(ctx,5);
    const where=`a.tenant_id=$1 AND ($2::text IS NULL OR COALESCE(a.equipment_type,'未分类')=$2) AND ($3::text IS NULL OR a.site_code=$3) AND
      ($4::text IS NULL OR strpos(lower(a.device_code),$4)>0 OR strpos(lower(a.device_name),$4)>0 OR strpos(lower(COALESCE(a.equipment_type,'')),$4)>0 OR strpos(lower(COALESCE(a.brand,'')),$4)>0 OR strpos(lower(COALESCE(a.model,'')),$4)>0)${scope.clause}`;
    const scopedValues=[...values,...scope.values];
    const total=Number((await currentQuery(client,`SELECT count(*) FROM current_assets a WHERE ${where}`,scopedValues)).rows[0].count);
    exportWindow(q,total,exportAll);
    const rows=(await currentQuery(client,`SELECT r.*,
      (SELECT count(*) FROM current_point_definitions p WHERE p.tenant_id=a.tenant_id AND p.device_code=a.device_code) AS points,
      (SELECT count(*) FROM current_measurements m WHERE m.tenant_id=a.tenant_id AND m.device_code=a.device_code) AS measurements
      FROM current_assets a JOIN current_import_rows r ON r.tenant_id=a.tenant_id AND r.ordinal=a.source_ordinal
      WHERE ${where} ORDER BY a.source_ordinal LIMIT $${5+scope.values.length} OFFSET $${6+scope.values.length}`,[...scopedValues,q.pageSize,(q.page-1)*q.pageSize])).rows;
    const visible=scopeSql(ctx,2),visibleValues=[ctx.tenantId,...visible.values];
    const summary=(await currentQuery(client,`SELECT
      (SELECT count(*) FROM current_assets a WHERE a.tenant_id=$1${visible.clause}) AS devices,
      (SELECT count(*) FROM current_point_definitions p JOIN current_assets a ON a.tenant_id=p.tenant_id AND a.device_code=p.device_code WHERE p.tenant_id=$1${visible.clause}) AS points,
      (SELECT count(*) FROM current_measurements m JOIN current_assets a ON a.tenant_id=m.tenant_id AND a.device_code=m.device_code WHERE m.tenant_id=$1${visible.clause}) AS measurements,
      (SELECT count(*) FROM current_measurements m JOIN current_assets a ON a.tenant_id=m.tenant_id AND a.device_code=m.device_code WHERE m.tenant_id=$1 AND m.quality<>'GOOD'${visible.clause}) AS non_good`,visibleValues)).rows[0];
    const types=(await currentQuery(client,`SELECT DISTINCT COALESCE(a.equipment_type,'未分类') AS type FROM current_assets a WHERE a.tenant_id=$1${visible.clause}`,visibleValues)).rows;
    const sites=(await currentQuery(client,`SELECT DISTINCT a.site_code FROM current_assets a WHERE a.tenant_id=$1${visible.clause}`,visibleValues)).rows;
    return {items:rows.map(r=>({asset:r.body,source:source(r),definedPoints:Number(r.points),measurements:Number(r.measurements)})),total,page:q.page,pageSize:q.pageSize,summary:{devices:Number(summary.devices),definedPoints:Number(summary.points),measurements:Number(summary.measurements),nonGoodMeasurements:Number(summary.non_good)},equipmentTypes:types.map(r=>r.type).sort(),sites:sites.map(r=>r.site_code).sort(),notice:overviewNotice};
  });
}
export async function dataMeasurementsSql(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,exportAll=false){
  const q=measurementQuery(params);
  return readView(pool,ctx,async client=>{
    const values=[ctx.tenantId,q.device||null,q.tag||null,q.quality||null,q.from===null?null:new Date(q.from).toISOString(),q.to===null?null:new Date(q.to).toISOString()],scope=scopeSql(ctx,7),scopedValues=[...values,...scope.values];
    const where=`m.tenant_id=$1 AND ($2::text IS NULL OR m.device_code=$2) AND ($3::text IS NULL OR m.tag_code=$3) AND ($4::text IS NULL OR m.quality=$4) AND ($5::timestamptz IS NULL OR m.measured_at>=$5) AND ($6::timestamptz IS NULL OR m.measured_at<=$6)${scope.clause}`;
    const total=Number((await currentQuery(client,`SELECT count(*) FROM current_measurements m JOIN current_assets a ON a.tenant_id=m.tenant_id AND a.device_code=m.device_code WHERE ${where}`,scopedValues)).rows[0].count);
    exportWindow(q,total,exportAll);
    const rows=(await currentQuery(client,`SELECT r.*,CASE WHEN p.source_ordinal IS NULL THEN NULL ELSE jsonb_build_object('label',p.tag_name,'unit',p.unit,'min',p.min_value,'max',p.max_value,'definitionBatchId',d.batch_id,'expectedIntervalSeconds',p.expected_interval_seconds,'origin','APPROVED_DEFINITION') END AS definition
      FROM current_measurements m JOIN current_import_rows r ON r.tenant_id=m.tenant_id AND r.ordinal=m.source_ordinal
      JOIN current_assets a ON a.tenant_id=m.tenant_id AND a.device_code=m.device_code
      LEFT JOIN current_point_definitions p ON p.tenant_id=m.tenant_id AND p.device_code=m.device_code AND p.tag_code=m.tag_code
      LEFT JOIN current_import_rows d ON d.tenant_id=p.tenant_id AND d.ordinal=p.source_ordinal
      WHERE ${where} ORDER BY m.measured_at DESC,r.batch_id,r.source_row LIMIT $${7+scope.values.length} OFFSET $${8+scope.values.length}`,[...scopedValues,q.pageSize,(q.page-1)*q.pageSize])).rows;
    const latest=(await currentQuery(client,`SELECT r.body->>'measured_at' AS time FROM current_measurements m JOIN current_import_rows r ON r.tenant_id=m.tenant_id AND r.ordinal=m.source_ordinal JOIN current_assets a ON a.tenant_id=m.tenant_id AND a.device_code=m.device_code WHERE ${where} ORDER BY m.measured_at DESC,r.batch_id,r.source_row LIMIT 1`,scopedValues)).rows[0]?.time||null;
    const definitionScope=scopeSql(ctx,4);
    const definitions=(await currentQuery(client,`SELECT r.* FROM current_point_definitions p JOIN current_import_rows r ON r.tenant_id=p.tenant_id AND r.ordinal=p.source_ordinal JOIN current_assets a ON a.tenant_id=p.tenant_id AND a.device_code=p.device_code WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.device_code=$2) AND ($3::text IS NULL OR p.tag_code=$3)${definitionScope.clause} ORDER BY p.source_ordinal LIMIT 100`,[ctx.tenantId,q.device||null,q.tag||null,...definitionScope.values])).rows;
    return {items:rows.map(r=>({measurement:r.body,source:source(r),definition:r.definition||approvedPoint(emptyImports(),ctx.tenantId,String(r.body.device_code),String(r.body.tag_code))||null})),total,page:q.page,pageSize:q.pageSize,dataAsOf:latest,definitions:definitions.map(r=>({point:r.body,source:source(r)})),notice:measurementNotice};
  });
}
