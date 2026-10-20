// Frozen legacy query reference; no schema or mutations.
const currentCte=`WITH current_import_rows AS (
 SELECT r.tenant_id,r.ordinal,COALESCE(c.batch_id,r.batch_id) AS batch_id,COALESCE(c.source_row,r.source_row) AS source_row,
 r.data_type,r.source_system,r.source_record_id,COALESCE(c.snapshot_digest,r.snapshot_digest) AS snapshot_digest,
 COALESCE(c.body,r.body) AS body,COALESCE(c.revision,1) AS record_version,c.previous_batch_id
 FROM managed_import_rows r LEFT JOIN LATERAL (SELECT * FROM managed_record_revisions v WHERE v.tenant_id=r.tenant_id AND v.root_ordinal=r.ordinal ORDER BY v.revision DESC LIMIT 1) c ON true WHERE r.tenant_id=$1
),current_assets AS (
 SELECT tenant_id,ordinal AS source_ordinal,body->>'device_code' AS device_code,body->>'device_name' AS device_name,body->>'site_code' AS site_code,body->>'line_code' AS line_code,NULLIF(body->>'equipment_type','') AS equipment_type,NULLIF(body->>'brand','') AS brand,NULLIF(body->>'model','') AS model FROM current_import_rows WHERE data_type='DEVICE'
),current_point_definitions AS (
 SELECT tenant_id,ordinal AS source_ordinal,body->>'device_code' AS device_code,body->>'tag_code' AS tag_code,body->>'tag_name' AS tag_name,body->>'unit' AS unit,(body->>'min_value')::float8 AS min_value,(body->>'max_value')::float8 AS max_value,NULLIF(body->>'expected_interval_seconds','')::integer AS expected_interval_seconds FROM current_import_rows WHERE data_type='POINT_DEFINITION'
),current_measurements AS (
 SELECT tenant_id,ordinal AS source_ordinal,body->>'device_code' AS device_code,body->>'tag_code' AS tag_code,(body->>'measured_at')::timestamptz AS measured_at,(body->>'value')::float8 AS value,body->>'quality' AS quality,body->>'unit' AS unit FROM current_import_rows WHERE data_type='MEASUREMENT'
) `;
export function currentQuery(client,text,values){return client.query(currentCte+text,values);}
