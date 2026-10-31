import {RuntimeProbeError, probeNeed, probeSignal, loopbackUrl} from './runtime-probe-error.ts';
export async function runtimeHttpJson(url: string, {headers = {}, signal, timeoutMs = 3000, maxBytes = 65536}: {
  headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number;
} = {}): Promise<any> {
  loopbackUrl(url);
  const timed = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, timed]) : timed;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, response: Response | undefined;
  try {
    probeSignal(combined);
    response = await fetch(url, {method: 'GET', headers, redirect: 'error', signal: combined});
    if (!response.ok) throw new RuntimeProbeError('HTTP_STATUS_FAILED');
    const length = response.headers.get('content-length');
    if (length !== null) probeNeed(/^\d+$/.test(length) && Number(length) <= maxBytes, 'HTTP_BODY_LIMIT');
    reader = response.body?.getReader(); probeNeed(reader, 'HTTP_RESPONSE_INVALID');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      probeSignal(combined); const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength; probeNeed(size <= maxBytes, 'HTTP_BODY_LIMIT'); chunks.push(value);
    }
    probeSignal(combined);
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { throw new RuntimeProbeError('HTTP_RESPONSE_INVALID'); }
  } catch (error) {
    if (error instanceof RuntimeProbeError) throw error;
    if (combined.aborted) throw new RuntimeProbeError('OBSERVATION_TIMEOUT', 'UNKNOWN');
    throw new RuntimeProbeError('HTTP_UNAVAILABLE');
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else await response?.body?.cancel().catch(() => {});
  }
}
