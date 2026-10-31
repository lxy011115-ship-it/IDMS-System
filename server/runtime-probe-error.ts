export type ProbeStatus = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_CONFIGURED';
export class RuntimeProbeError extends Error {
  code: string;
  status: Exclude<ProbeStatus,'PASS'>;
  constructor(code: string, status: Exclude<ProbeStatus,'PASS'> = 'FAIL') { super(code); this.code = code; this.status = status; }
}
export function probeNeed(value: unknown, code = 'CONFIG_INVALID'): asserts value {
  if (!value) throw new RuntimeProbeError(code);
}
export function probeSignal(signal?: AbortSignal, deadline = Infinity) {
  if (signal?.aborted || performance.now() >= deadline) throw new RuntimeProbeError('OBSERVATION_TIMEOUT', 'UNKNOWN');
}
export function loopbackUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new RuntimeProbeError('LOCAL_ENDPOINT_REQUIRED'); }
  probeNeed(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash, 'LOCAL_ENDPOINT_REQUIRED');
  return url;
}
