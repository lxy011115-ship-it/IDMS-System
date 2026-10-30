import {scopeFilter,type AccessContext} from './access.ts';
import {ownTaskScope} from './data-scope.ts';

/** Appends CTEs to currentQuery, which resolves approved device corrections first.
 * Parameter positions 1..6 are fixed for all spares queries. No all-tenant arrays
 * are transferred to the application to decide visibility. */
export function spareQueryScope(ctx:AccessContext){
 const scope=scopeFilter(ctx),values:unknown[]=[ctx.tenantId,scope.sites,scope.lines,scope.devices,ownTaskScope(ctx),ctx.actorId];
 const deviceScope=(alias:string)=>`($2::text[] IS NULL OR ${alias}.site_code=ANY($2)) AND ($3::text[] IS NULL OR ${alias}.line_code=ANY($3)) AND ($4::text[] IS NULL OR ${alias}.device_code=ANY($4))`;
 const cte=`,spare_devices AS MATERIALIZED (
 SELECT a.* FROM current_assets a WHERE a.tenant_id=$1 AND ${deviceScope('a')}
 ),spare_orders AS MATERIALIZED (
 SELECT o.* FROM public.business_work_orders o
 LEFT JOIN current_assets a ON a.tenant_id=o.tenant_id AND a.device_code=o.body->>'deviceCode'
 LEFT JOIN public.business_devices d ON d.tenant_id=o.tenant_id AND d.body->>'code'=o.body->>'deviceCode'
 WHERE o.tenant_id=$1 AND (NOT $5::boolean OR o.body->>'assignee'=$6)
 AND ($2::text[] IS NULL OR a.site_code=ANY($2))
 AND ($3::text[] IS NULL OR (CASE WHEN a.device_code IS NULL THEN d.body->>'line' ELSE a.line_code END)=ANY($3))
 AND ($4::text[] IS NULL OR o.body->>'deviceCode'=ANY($4))
 ),spare_visible AS NOT MATERIALIZED (
 SELECT e.* FROM idms_spares.entities e WHERE e.tenant_id=$1
 AND ($2::text[] IS NULL OR e.site_code=ANY($2))
 AND (COALESCE(e.body->>'deviceCode','')='' OR EXISTS(SELECT 1 FROM spare_devices a WHERE a.device_code=e.body->>'deviceCode'))
 AND (COALESCE(e.body->>'workOrderId','')='' OR EXISTS(SELECT 1 FROM spare_orders o WHERE o.id=e.body->>'workOrderId'))
 ) `;
 return {values,cte};
}
