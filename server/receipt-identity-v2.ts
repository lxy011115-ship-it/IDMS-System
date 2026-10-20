// UUID identity is case-insensitive; the stored signed text remains exact.
// This is persisted tuple matching, not historical signature authentication.
export const receiptVerificationVersion='persisted-uuid-receipt-binding-2.0.0' as const;
export const originalReceiptUuidV2=`r.event_id ~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' AND lower(r.event_id)=w.id::text AND r.envelope->>'eventId'=r.event_id`;
