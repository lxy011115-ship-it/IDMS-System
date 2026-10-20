import type {Store} from './store.ts';
import type {BatchBody,ImportView} from './imports.ts';
import type {AuditEvent} from './domain.ts';
import type {AuditPagePlan,AuditPageSlice} from './audit-page.ts';
export type StoreView=Omit<Store,'audits'|'idempotency'>;
export interface ReadWorkspaceData {store:StoreView;imports:ImportView}
// Providers belong to one active request snapshot and are never cached.
export interface ReadWorkspace extends ReadWorkspaceData {
 readOriginal:(batch:BatchBody)=>Promise<Buffer>;
 readAudits:()=>Promise<AuditEvent[]>;
 readAuditPage:(plan:AuditPagePlan,visible:(event:AuditEvent)=>boolean)=>Promise<AuditPageSlice>;
}
