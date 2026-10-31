import type pg from 'pg';
import {cancelSpareQuery} from './spares-cancel.ts';
import {RuntimeProbeError, probeSignal, probeNeed} from './runtime-probe-error.ts';

/** Owns only one borrowed session, never the shared pool. Expiry is an observation,
 * not proof of termination: await acquisition/query/cancel/rollback/transport. */
export async function runtimeReadOnly<T>(pool: pg.Pool, check: (client: pg.PoolClient) => Promise<T>, {
  signal, timeoutMs = 3000, cancel = cancelSpareQuery
}: {signal?: AbortSignal; timeoutMs?: number; cancel?: typeof cancelSpareQuery} = {}): Promise<T> {
  probeNeed(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 5000);
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let client: pg.PoolClient | undefined, ended: Promise<void> | undefined, cancellation: Promise<unknown> | undefined;
  let transaction = false, success = false;
  let finishEnd: (() => void) | undefined;
  const onEnd = () => finishEnd?.(), onError = () => {};
  const abort = () => { if (client) cancellation ??= Promise.resolve(cancel(client)).catch(() => false); };
  try {
    probeSignal(combined);
    client = await pool.connect(); // Await even if observation expires while queued.
    ended = new Promise<void>(done => { finishEnd = done; client!.once('end', onEnd); });
    client.on('error', onError);
    combined.addEventListener('abort', abort, {once: true}); probeSignal(combined);
    await client.query('BEGIN READ ONLY'); transaction = true;
    await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [String(timeoutMs)]);
    const value = await check(client); probeSignal(combined);
    await client.query('ROLLBACK'); transaction = false; probeSignal(combined);
    success = true; return value;
  } catch (error) {
    if (combined.aborted || (error as any)?.code === '57014') throw new RuntimeProbeError('OBSERVATION_TIMEOUT', 'UNKNOWN');
    if (error instanceof RuntimeProbeError) throw error;
    throw new RuntimeProbeError('DATABASE_UNAVAILABLE');
  } finally {
    combined.removeEventListener('abort', abort); await cancellation;
    if (client) {
      if (transaction) try { await client.query('ROLLBACK'); } catch {}
      if (success) { client.off('end', onEnd); client.off('error', onError); client.release(); }
      else { client.release(true); await ended; client.off('error', onError); }
    }
  }
}
