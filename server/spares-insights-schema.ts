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
