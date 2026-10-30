import type pg from 'pg';
import {DomainError} from './service.ts';
/** Explicit opt-in migration. Existing event bytes and posted facts stay intact. */
export const sparesInsightsSchema=`
CREATE TABLE IF NOT EXISTS idms_spares.material_plan_records PARTITION OF idms_spares.entities FOR VALUES IN ('material-plan');
CREATE UNIQUE INDEX IF NOT EXISTS spares_material_plan_unique ON idms_spares.material_plan_records(tenant_id,(body->>'workOrderId'),(body->>'partId'),(body->>'warehouseId'));
CREATE INDEX IF NOT EXISTS spares_material_plan_pair ON idms_spares.material_plan_records(tenant_id,(body->>'partId'),(body->>'warehouseId'),(body->>'status'));
CREATE INDEX IF NOT EXISTS spares_order_material_movements ON idms_spares.movement_records(tenant_id,(body->>'workOrderId'),(body->>'partId'),(body->>'warehouseId'),(body->>'type'));
CREATE INDEX IF NOT EXISTS spares_replacement_dates ON idms_spares.replacement_records(tenant_id,(body->>'linkId'),(body->>'date'));
INSERT INTO idms_spares.migrations(name,version) VALUES('insights',1) ON CONFLICT(name) DO NOTHING;
UPDATE idms_spares.migrations SET version=2 WHERE name='capacity' AND version=1;
`;
/** A marker alone must not advertise a missing partition or unique index. */
export async function assertSparesInsightsSchema(client:pg.PoolClient){
 const rows=(await client.query(`SELECT m.version,
 EXISTS(SELECT 1 FROM pg_class p JOIN pg_inherits h ON h.inhrelid=p.oid
 WHERE p.oid=to_regclass('idms_spares.material_plan_records')
 AND h.inhparent=to_regclass('idms_spares.entities')
 AND pg_get_expr(p.relpartbound,p.oid)='FOR VALUES IN (''material-plan'')') AS partition_ready,
 EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('idms_spares.spares_material_plan_unique')
 AND i.indrelid=to_regclass('idms_spares.material_plan_records') AND i.indisunique AND i.indisvalid) AS unique_ready
 FROM idms_spares.migrations m WHERE m.name='insights'`)).rows;
 if(rows.length!==1||rows[0].version!==1||!rows[0].partition_ready||!rows[0].unique_ready)throw new DomainError(503,'备件用料计划结构、索引或能力标记不完整，请核对专用迁移');
}
