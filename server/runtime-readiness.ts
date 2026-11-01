import {runtimeBoundedFile} from './runtime-file.ts';
import {RuntimeProbeError,type ProbeStatus} from './runtime-probe-error.ts';

export const readinessComponents = ['business','sessions','identity','workflow','predictor','ai','telemetry'] as const;
export type ReadinessComponent = typeof readinessComponents[number];
export interface ReadinessPolicy {
  format: 1; enabled: boolean; required: ReadinessComponent[]; optional: ReadinessComponent[];
  intervalMs: number; budgetMs: number; probeMs: number; maxAgeMs: number;
}
export interface ProbeResult {status: ProbeStatus; code: string; evidence: string}
export type ReadinessTask = (context: {signal: AbortSignal; deadline: number; timeoutMs: number}) => Promise<ProbeResult>;
export const readinessCodes = new Set([
  'CHECK_PASSED','NOT_CONFIGURED','CONFIG_INVALID','PROBE_FAILED','OBSERVATION_TIMEOUT','PROBE_NOT_STARTED',
  'LOCAL_ENDPOINT_REQUIRED','HTTP_STATUS_FAILED','HTTP_UNAVAILABLE','HTTP_BODY_LIMIT','HTTP_RESPONSE_INVALID',
  'DATABASE_UNAVAILABLE','DATABASE_BINDING_MISMATCH','SESSION_BINDING_MISMATCH','ISSUER_MISMATCH',
  'WORKFLOW_CONTRACT_MISMATCH','AI_CONTRACT_MISMATCH','PREDICTOR_CONTRACT_MISMATCH',
  'TELEMETRY_CONTRACT_MISMATCH','TELEMETRY_CONNECTION_FAILED','TELEMETRY_BUFFER_FULL','TELEMETRY_SAMPLE_UNCONFIRMED','TELEMETRY_STORAGE_LIMIT','TELEMETRY_QUARANTINE_PENDING'
]);
export function readinessPolicy(value: unknown): ReadinessPolicy {
  const p = value as ReadinessPolicy;
  const fields = ['format','enabled','required','optional','intervalMs','budgetMs','probeMs','maxAgeMs'];
  const bad = () => { throw new RuntimeProbeError('CONFIG_INVALID'); };
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !fields.includes(k))
      || p.format !== 1 || typeof p.enabled !== 'boolean' || !Array.isArray(p.required) || !Array.isArray(p.optional)) bad();
  const all = [...p.required,...p.optional];
  if (all.length !== readinessComponents.length || new Set(all).size !== all.length
      || all.some(k => !readinessComponents.includes(k)) || ['business','sessions','identity'].some(k => !p.required.includes(k as ReadinessComponent))) bad();
  for (const [key,min,max] of [['intervalMs',1000,60000],['budgetMs',100,30000],['probeMs',50,5000],['maxAgeMs',1000,180000]] as const)
    if (!Number.isSafeInteger(p[key]) || p[key] < min || p[key] > max) bad();
  if (p.budgetMs >= p.intervalMs || p.maxAgeMs < p.intervalMs || p.probeMs > p.budgetMs) bad();
  return structuredClone(p);
}
export async function loadReadinessPolicy(path?: string): Promise<{policy: ReadinessPolicy | null; code: string}> {
  if (!path) return {policy: null, code: 'NOT_CONFIGURED'};
  try {
    const bytes = await runtimeBoundedFile(path,16384);
    return {policy: readinessPolicy(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''))), code: 'NOT_CONFIGURED'};
  } catch { return {policy: null, code: 'CONFIG_INVALID'}; }
}
const advice:Record<string,string>={
 CHECK_PASSED:'仅所列运行证据通过，企业签收与生产验收另行完成。',
 NOT_CONFIGURED:'核对既有组件配置，不调用初始化或授权来替代检查。',
 CONFIG_INVALID:'核对明确的配置和范围，不能静默省略必需项。',
 OBSERVATION_TIMEOUT:'等待本轮原任务取消和实际收尾，不另启重复探测。',
 PROBE_NOT_STARTED:'观察预算内未启动，不能当作通过。',
 TELEMETRY_BUFFER_FULL:'核对接收和确认链路，保留未确认缓存，不以删除资料恢复绿灯。',
 TELEMETRY_STORAGE_LIMIT:'边缘数据库或WAL达到观察限额，保全原记录并按维护流程核对空间。',
 TELEMETRY_QUARANTINE_PENDING:'已提交拒绝的原消息仍在隔离区待处置；移出待确认队列不代表错误已解决。',
 TELEMETRY_CONNECTION_FAILED:'核对主站连接/订阅和边缘状态，端口可达不能证明采集正常。',
 LOCAL_ENDPOINT_REQUIRED:'当前适配器只核对明确回环端点，远端拓扑需单独适配。'
};
function safeResult(value: ProbeResult | unknown): ProbeResult {
  const r = value as ProbeResult;
  if (!r || !['PASS','FAIL','UNKNOWN','NOT_CONFIGURED'].includes(r.status) || !readinessCodes.has(r.code)
      || !/^[A-Z0-9_]{1,80}$/.test(r.evidence) || (r.status==='PASS')!==(r.code==='CHECK_PASSED')) return {status:'UNKNOWN',code:'PROBE_FAILED',evidence:'NOT_ESTABLISHED'};
  return {status:r.status,code:r.code,evidence:r.evidence};
}
function failure(error: unknown): ProbeResult {
  return error instanceof RuntimeProbeError && readinessCodes.has(error.code)
    ? safeResult({status:error.status,code:error.code,evidence:'NOT_ESTABLISHED'})
    : {status:'UNKNOWN',code:'PROBE_FAILED',evidence:'NOT_ESTABLISHED'};
}
export class RuntimeReadiness {
  private policy: ReadinessPolicy | null;
  private tasks: Record<ReadinessComponent,ReadinessTask>;
  private now: () => number;
  private wall: () => string;
  private configuredCode: string;
  private running: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private started = false;
  private invalidated = false;
  private current = new Map<ReadinessComponent,ProbeResult>();
  private snapshot: {at:number;checkedAt:string;rows:Array<ProbeResult & {component:ReadinessComponent;required:boolean}>} | undefined;
  constructor(policy: ReadinessPolicy | null, tasks: Record<ReadinessComponent,ReadinessTask>, options: {
    now?: () => number; wall?: () => string; code?: string; enterprise?: boolean;
  } = {}) {
    this.policy = policy ? readinessPolicy(policy) : null; this.tasks = tasks;
    this.now = options.now || (() => performance.now()); this.wall = options.wall || (() => new Date().toISOString());
    this.configuredCode = options.enterprise === false ? 'NOT_CONFIGURED' : options.code || 'NOT_CONFIGURED';
    if (options.enterprise === false) this.policy = null;
  }
  start() {
    if (this.started || this.closing) return; this.started = true;
    if (!this.policy?.enabled) return;
    const tick = async () => {
      const at = this.now(); await this.refresh();
      if (!this.closing) { this.timer = setTimeout(() => void tick(), Math.max(0,this.policy!.intervalMs-(this.now()-at))); this.timer.unref?.(); }
    };
    void tick();
  }
  refresh(): Promise<void> {
    if (this.running) return this.running;
    if (this.closing || !this.policy?.enabled) return Promise.resolve();
    const policy = this.policy, controller = this.controller = new AbortController(), at = this.now(), checkedAt = this.wall();
    this.current = new Map(); let next = 0;
    const expire = () => { this.invalidated = true; controller.abort(); };
    const timer = setTimeout(expire,policy.budgetMs);
    const work = async () => {
      try {
        await Promise.all(Array.from({length:2},async () => {
          for (;;) {
            const index = next++; if (index >= readinessComponents.length) return;
            const component = readinessComponents[index]; let result: ProbeResult;
            if (controller.signal.aborted || this.now()-at >= policy.budgetMs) {
              expire(); result = {status:'UNKNOWN',code:'PROBE_NOT_STARTED',evidence:'NOT_ESTABLISHED'};
            } else {
              try { result = safeResult(await this.tasks[component]({signal:controller.signal,deadline:performance.now()+Math.max(0,policy.budgetMs-(this.now()-at)),timeoutMs:policy.probeMs})); }
              catch (error) { result = failure(error); }
              if (controller.signal.aborted || this.now()-at >= policy.budgetMs) {
                expire(); result = {status:'UNKNOWN',code:'OBSERVATION_TIMEOUT',evidence:'SETTLED_AFTER_CANCELLATION'};
              }
            }
            this.current.set(component,result);
            if (policy.required.includes(component) && result.status !== 'PASS') this.invalidated = true;
          }
        }));
        const rows = readinessComponents.map(component => ({component,required:policy.required.includes(component),...this.current.get(component)!}));
        if (!this.closing) {
          this.snapshot = {at,checkedAt,rows};
          this.invalidated = controller.signal.aborted || rows.some(r => r.required && r.status !== 'PASS');
        }
      } finally { clearTimeout(timer); }
    };
    this.running = work().finally(() => { this.running = undefined; this.controller = undefined; });
    return this.running;
  }
  view() {
    const s = this.snapshot, age = s ? this.now()-s.at : null;
    const fresh = age !== null && Number.isFinite(age) && age >= 0 && age <= (this.policy?.maxAgeMs || 0);
    const reason = this.closing ? 'CLOSING' : !this.policy?.enabled ? this.configuredCode : !s ? 'WARMING'
      : !fresh ? 'STALE' : this.invalidated ? 'DEPENDENCY_NOT_READY' : 'CHECK_PASSED';
    const ready = reason === 'CHECK_PASSED';
    const publicResult = {format:1,status:ready?'READY':'NOT_READY',checkedAt:s?.checkedAt || null,
      ageMs:age !== null && Number.isFinite(age) && age >= 0 ? Math.round(age) : null,productionApproved:false};
    const rows = readinessComponents.map(component => {
      const base = s?.rows.find(r => r.component === component);
      const result = this.current.get(component) || base || {status:'NOT_CONFIGURED' as ProbeStatus,code:'NOT_CONFIGURED',evidence:'NOT_ESTABLISHED'};
      return {component,required:this.policy?.required.includes(component) || false,...safeResult(result),advice:advice[result.code]||'按组件固定代码核对运行依赖；不自动重启、修复或修改业务。'};
    });
    return {ready,publicResult,detail:{...publicResult,reason,running:!!this.running,rows}};
  }
  beginClose() { this.closing = true; if (this.timer) clearTimeout(this.timer); this.controller?.abort(); }
  async close() { this.beginClose(); await this.running; }
}
