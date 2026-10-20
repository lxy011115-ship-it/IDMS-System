import { createHash, randomUUID } from "node:crypto";
import type { ActorType, AuditEvent } from "./domain.ts";
import type { Store } from "./store.ts";

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
};
export function appendAudit(store: Store, input: Omit<AuditEvent, "eventId" | "businessTime" | "previousHash" | "hash">): AuditEvent {
  const previousHash = [...store.audits].reverse().find(e => e.tenantId === input.tenantId)?.hash ?? "GENESIS";
  // Audit evidence must be a frozen point-in-time value, not a reference into mutable business state.
  const base = { ...structuredClone(input), eventId: randomUUID(), businessTime: new Date().toISOString(), previousHash };
  const hash = createHash("sha256").update(previousHash + stable(base)).digest("hex");
  const event: AuditEvent = { ...base, hash };
  store.audits.push(event);
  return event;
}

// New issuance flows bind their body to this one captured audit clock. The
// builder computes evidence only; it must not append another audit event.
export function appendClockBoundAudit(store:Store,build:(businessTime:string)=>Omit<AuditEvent,'eventId'|'businessTime'|'previousHash'|'hash'>):AuditEvent{
 const offset=store.audits.length,businessTime=new Date().toISOString(),input=build(businessTime);if(store.audits.length!==offset)throw Error('Audit evidence builder mutated history');
 const previousHash=[...store.audits].reverse().find(e=>e.tenantId===input.tenantId)?.hash??'GENESIS',base={...structuredClone(input),eventId:randomUUID(),businessTime,previousHash},hash=createHash('sha256').update(previousHash+stable(base)).digest('hex'),event={...base,hash};store.audits.push(event);return event;
}

export class AuditChainVerifier {
 private previous='GENESIS';private broken=false;readonly tenantId:string;
 constructor(tenantId:string){this.tenantId=tenantId;}
 accept(event:AuditEvent):boolean{
  if(this.broken)return false;const {hash,...base}=event;
  if(event.tenantId!==this.tenantId||event.previousHash!==this.previous||createHash('sha256').update(this.previous+stable(base)).digest('hex')!==hash){this.broken=true;return false;}this.previous=hash;return true;
 }
 get tip(){return this.previous;}
}
export function verifyAuditChain(events: AuditEvent[], tenantId: string): boolean {
 const chain=new AuditChainVerifier(tenantId);for(const event of events)if(event.tenantId===tenantId&&!chain.accept(event))return false;return true;
}

export function actor(headers: Record<string, string | string[] | undefined>): { actorType: ActorType; actorId: string } {
  return { actorType: (headers["x-actor-type"] as ActorType) || "USER", actorId: String(headers["x-actor-id"] || "demo.admin") };
}
