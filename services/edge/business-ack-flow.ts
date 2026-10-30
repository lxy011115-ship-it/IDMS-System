import type { EdgeSpool } from './spool.ts';

export interface BusinessAckFlowOptions {
  version: 1;
  window: number;
  ackTimeoutMs: number;
  maxRetryMs: number;
}
export const defaultBusinessAckFlowOptions: Readonly<BusinessAckFlowOptions> = Object.freeze({
  version: 1, window: 1, ackTimeoutMs: 60000, maxRetryMs: 300000,
});
export function businessAckFlowOptions(input: unknown): BusinessAckFlowOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('FLOW_CONFIG_INVALID');
  const value = input as Record<string, unknown>;
  const keys = ['version', 'window', 'ackTimeoutMs', 'maxRetryMs'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw Error('FLOW_CONFIG_INVALID');
  if (value.version !== 1 || !Number.isSafeInteger(value.window) || Number(value.window) < 1 || Number(value.window) > 8
    || !Number.isSafeInteger(value.ackTimeoutMs) || Number(value.ackTimeoutMs) < 5000 || Number(value.ackTimeoutMs) > 300000
    || !Number.isSafeInteger(value.maxRetryMs) || Number(value.maxRetryMs) < Number(value.ackTimeoutMs) || Number(value.maxRetryMs) > 900000) throw Error('FLOW_CONFIG_INVALID');
  return { version: 1, window: Number(value.window), ackTimeoutMs: Number(value.ackTimeoutMs), maxRetryMs: Number(value.maxRetryMs) };
}

type Publish = (payload: string, done: (error?: Error | null) => void) => void;
interface Attempt {
  id: string;
  payload: string;
  sentAt: number;
  dueAt: number;
  retry: number;
  transportPending: boolean;
  completed: boolean;
}

/** Simulator-only flow control. The frozen spool remains the authority for business ACKs. */
export class BusinessAckFlow {
  private readonly options: BusinessAckFlowOptions;
  private readonly active = new Map<string, Attempt>();
  private readonly startupDue = new Map<string, number>();
  private stopped = false;
  private published = 0;
  private retries = 0;
  private acceptedAcks = 0;
  private invalidAcks = 0;
  private publishErrors = 0;
  private lastAckLatencyMs: number | null = null;
  private readonly spool: EdgeSpool;
  private readonly publish: Publish;
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => number;

  constructor(spool: EdgeSpool, publish: Publish,
    options: BusinessAckFlowOptions = { ...defaultBusinessAckFlowOptions },
    monotonicNow: () => number = () => performance.now(),
    wallNow: () => number = () => Date.now()) {
    this.options = businessAckFlowOptions(options);
    this.spool = spool; this.publish = publish; this.monotonicNow = monotonicNow; this.wallNow = wallNow;
  }

  tick(ready: boolean): void {
    if (this.stopped || !ready) return;
    const now = this.monotonicNow();
    for (const attempt of this.active.values()) {
      if (!attempt.completed && !attempt.transportPending && now >= attempt.dueAt) {
        attempt.retry++;
        this.send(attempt, now);
      }
    }
    const rows = this.spool.db.prepare("SELECT event_id,payload,last_attempt FROM pending WHERE state='PENDING' ORDER BY rowid LIMIT ?")
      .all(this.options.window) as { event_id: string; payload: string; last_attempt: number }[];
    const currentIds = new Set(rows.map(row => row.event_id));
    for (const id of this.startupDue.keys()) if (!currentIds.has(id)) this.startupDue.delete(id);
    for (const row of rows) {
      if (this.active.size >= this.options.window) break;
      if (this.active.has(row.event_id)) continue;
      let due = this.startupDue.get(row.event_id);
      if (due === undefined) {
        const elapsed = Math.max(0, this.wallNow() - row.last_attempt);
        due = now + (row.last_attempt === 0 ? 0 : Math.max(0, this.options.ackTimeoutMs - elapsed));
        this.startupDue.set(row.event_id, due);
      }
      if (now < due) continue;
      this.startupDue.delete(row.event_id);
      const attempt: Attempt = { id: row.event_id, payload: row.payload, sentAt: now, dueAt: now, retry: 0, transportPending: false, completed: false };
      this.active.set(attempt.id, attempt);
      this.send(attempt, now);
    }
  }

  private send(attempt: Attempt, now: number): void {
    attempt.sentAt = now;
    attempt.dueAt = now + Math.min(this.options.maxRetryMs, this.options.ackTimeoutMs * 2 ** Math.min(attempt.retry, 20));
    attempt.transportPending = true;
    try {
      this.spool.attempted(attempt.id);
      this.published++;
      if (attempt.retry) this.retries++;
      let called = false;
      this.publish(attempt.payload, error => {
        if (called) return;
        called = true;
        attempt.transportPending = false;
        if (error) this.publishErrors++;
        if (attempt.completed && this.active.get(attempt.id) === attempt) this.active.delete(attempt.id);
      });
    } catch {
      attempt.transportPending = false;
      this.publishErrors++;
      // Keep the slot and its deadline. A synchronous transport failure is not a business ACK.
    }
  }

  acknowledge(input: unknown): boolean {
    if (this.stopped) return false;
    const accepted = this.spool.acknowledge(input);
    if (!accepted) { this.invalidAcks++; return false; }
    this.acceptedAcks++;
    const id = (input as { eventId: string }).eventId;
    this.startupDue.delete(id);
    const attempt = this.active.get(id);
    if (attempt) {
      this.lastAckLatencyMs = Math.max(0, this.monotonicNow() - attempt.sentAt);
      attempt.completed = true;
      if (!attempt.transportPending) this.active.delete(id);
    }
    return true;
  }

  snapshot() {
    return { version: 'business-ack-window-v1', window: this.options.window,
      ackTimeoutMs: this.options.ackTimeoutMs, maxRetryMs: this.options.maxRetryMs,
      occupied: this.active.size, awaitingBusinessAck: [...this.active.values()].filter(a => !a.completed).length,
      awaitingPuback: [...this.active.values()].filter(a => a.transportPending).length,
      published: this.published, retries: this.retries, acceptedAcks: this.acceptedAcks,
      invalidAcks: this.invalidAcks, publishErrors: this.publishErrors,
      lastAckLatencyMs: this.lastAckLatencyMs, stopped: this.stopped };
  }

  stop(): void { this.stopped = true; this.startupDue.clear(); }
}
