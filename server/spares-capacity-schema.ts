/** Additive indexes; data, posted records and existing event wire format are preserved. */
export const sparesCapacitySchema=`
CREATE TABLE IF NOT EXISTS idms_spares.migrations(name text PRIMARY KEY,version integer NOT NULL,installed_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS spares_entity_lookup ON idms_spares.entities(tenant_id,id);
${['part','supplier','warehouse'].map(kind=>`CREATE UNIQUE INDEX IF NOT EXISTS spares_${kind}_code_unique ON idms_spares.${kind}_records(tenant_id,(lower(body->>'code')));`).join('\n')}
CREATE UNIQUE INDEX IF NOT EXISTS spares_document_number_unique ON idms_spares.document_records(tenant_id,(body->>'type'),(body->>'number'));
CREATE UNIQUE INDEX IF NOT EXISTS spares_link_position_unique ON idms_spares.link_records(tenant_id,(body->>'partId'),(body->>'deviceCode'),(body->>'position'));
CREATE INDEX IF NOT EXISTS spares_stock_lookup ON idms_spares.movement_records(tenant_id,(body->>'partId'),(body->>'warehouseId'));
CREATE INDEX IF NOT EXISTS spares_receipt_returns ON idms_spares.movement_records(tenant_id,(body->>'receiptId'),(body->>'type'));
CREATE INDEX IF NOT EXISTS spares_issue_returns ON idms_spares.movement_records(tenant_id,(body->>'issueId'),(body->>'type'));
CREATE INDEX IF NOT EXISTS spares_issue_installations ON idms_spares.replacement_records(tenant_id,(body->>'issueId'));
CREATE INDEX IF NOT EXISTS spares_purchase_documents ON idms_spares.document_records(tenant_id,(body->>'purchaseId'),(body->>'type'));
CREATE INDEX IF NOT EXISTS spares_purchase_receipts ON idms_spares.receipt_records(tenant_id,(body->>'purchaseId'),(body->>'lineId'));
INSERT INTO idms_spares.migrations(name,version) VALUES('capacity',1) ON CONFLICT(name) DO NOTHING;
`;
