import { createHash, randomUUID } from "node:crypto";
import { appendAudit } from "./audit.ts";
import { requireAccess,scopeAllows, type AccessContext } from './access.ts';
import { DomainError } from "./service.ts";
import type { Store } from "./store.ts";
import { measurementSchema } from "./measurement-schema.ts";
import {approvedPoint,deviceOptionalFields,pointOptionalFields,legacyPointCompatible} from './point-definitions.ts';
import type { ReviewReceipt } from '../integrations/ai.ts';
import {bindEquipmentProfile,equipmentBindingForDevice,inheritedProfileBinding,prepareProfileRows,validateProfileRow,type EquipmentProfileBinding} from './equipment-profiles.ts';
import {dataScope} from './data-scope.ts';
import { suspiciousInstruction } from '../integrations/ai.ts';
import {effectiveRecords,bindCorrection,withoutCorrectionTargets,batchInputDigest,type CorrectionBinding} from './import-revisions.ts';

export const definitions = {
  DEVICE: { name: "设备台账", file: "devices.csv", fields: ["source_record_id", "device_code", "device_name", "site_code", "line_code",...deviceOptionalFields] },
  POINT_DEFINITION: {name:'测点定义',file:'point-definitions.csv',fields:['source_record_id','device_code','tag_code','tag_name','unit','min_value','max_value',...pointOptionalFields]},
  PRODUCTION: { name: "班次生产", file: "production.csv", fields: ["source_record_id", "device_code", "shift_code", "period_start", "period_end", "planned_minutes", "total_count", "good_count", "ideal_cycle_seconds"] },
  STATE_INTERVAL: { name: "状态区间", file: "state-intervals.csv", fields: ["source_record_id", "device_code", "start_time", "end_time", "state", "reason_code"] },
  MAINTENANCE: { name: "维修记录", file: "maintenance.csv", fields: ["source_record_id", "device_code", "failure_time", "repair_start", "repair_end", "failure_code", "cause", "action"] },
  QUALITY: { name: "质量检验", file: "quality.csv", fields: ["source_record_id", "device_code", "batch_code", "characteristic_code", "measured_at", "sample_no", "measured_value", "unit", "lsl", "usl"] },
  MEASUREMENT: {name:"设备测点",file:"measurements.csv",fields:["source_record_id","device_code","tag_code","measured_at","value","unit","quality"]}
} as const;
export type DataType = keyof typeof definitions;
export type Row = Record<string, string | number>;
export interface ImportContext extends AccessContext {}
export interface RowError { row: number; field: string; code: string; message: string;sourceField?:string }
import {mapRows,validateHeaders,mappedSnapshotDigest,type MappingBinding} from './import-mapping.ts';
import {bindImportMapping,verifyBatchMapping} from './catalog.ts';
export interface BatchBody {
  batchId: string; tenantId: string; dataType: DataType; status: string; version: number; createdAt: string; correlationId: string;
  uploader: string; sourceSystem: string; sourceKind: string; filename: string; templateVersion: string; fileSha256: string; snapshotDigest: string;
  mime: string; rows: Row[]; lineNumbers: number[]; validRows: Row[]; errors: RowError[];
  counts: { total: number; valid: number; invalid: number; duplicates: number; committed: number };
  aiReview: { status: string; conclusion: string; confidence: number | null; evidence: string[]; modelVersion: string;
    gateway?:{requestId:string;requestDigest:string;mode:'SHADOW';promptVersion:string;policyVersion:string;modelDigest:string;sampledRows:number;totalRows:number;receipt?:ReviewReceipt} };
  approval?: { decision: string; comment: string; approver: string; decidedAt: string; reviewResolution: string };
  committedAt?: string; reportStatus: string;
  mappingBinding?:MappingBinding;sourceHeaders?:string[];correction?:CorrectionBinding;equipmentProfileBinding?:EquipmentProfileBinding;
}
export interface Batch extends BatchBody {originalBase64:string}
export interface StoredRow { tenantId: string; sourceSystem: string; dataType: DataType; batchId: string; row: number; value: Row }
export interface ImportView<B extends BatchBody=BatchBody> {batches:readonly B[];records:readonly StoredRow[]}
export interface ImportData extends ImportView<Batch> { batches: Batch[]; records: StoredRow[]; requests: { key: string; digest: string; batchId: string }[] }
export const emptyImports = (): ImportData => ({ batches: [], records: [], requests: [] });
export const digest = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function authorize(ctx: ImportContext, action: "read" | "upload" | "approve") {
  if (ctx.actorType !== "USER" && !(ctx.actorType === "INTERFACE" && action !== "approve" && ctx.actorId === "demo.connector")) throw new DomainError(403, "AI 或接口身份不得执行人工审批");
  requireAccess(ctx, action);
}
export function getBatch<B extends BatchBody>(data: ImportView<B>, id: string, ctx: ImportContext): B {
  authorize(ctx, "read");
  const batch = data.batches.find(b => b.batchId === id && b.tenantId === ctx.tenantId);
  if (!batch||!dataScope(data,ctx).batch(batch)) throw new DomainError(404, "当前租户内批次不存在或不在授权范围");
  return batch;
}
export function present(batch: BatchBody) {
  const { originalBase64, rows, validRows, errors, lineNumbers, ...summary } = {...batch,originalBase64:undefined};
  return { ...summary, preview: rows.slice(0, 20), errors: errors.slice(0, 100), auditMode: "local-demo" };
}

// RFC4180 quoting, CRLF, embedded newlines and physical row locations.
export function parseCsv(text: string,mapped=false): { rows: Row[]; lineNumbers: number[]; sourceHeaders:string[] } {
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = []; const lineNumbers: number[] = [];
  let values: string[] = [], cell = "", quoted = false, afterQuote = false, line = 1, rowLine = 1;
  const pushRow = () => { values.push(cell); if (values.some(v => v.trim())) { rows.push(values); lineNumbers.push(rowLine); } values = []; cell = ""; afterQuote = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; afterQuote = true; } } else { cell += c; if (c === "\n") line++; } continue; }
    if (c === '"') { if (cell || afterQuote) throw new DomainError(400, `CSV第${line}行引号格式错误`); quoted = true; }
    else if (c === ",") { values.push(cell); cell = ""; afterQuote = false; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; pushRow(); line++; rowLine = line; }
    else { if (afterQuote) throw new DomainError(400, `CSV第${line}行引号后有非法字符`); cell += c; }
  }
  if (quoted) throw new DomainError(400, "CSV引号未闭合");
  if (cell || values.length) pushRow();
  const sourceHeaders=rows.shift()||[],header=validateHeaders(sourceHeaders,mapped);lineNumbers.shift();
  if (rows.some(r => r.length !== header.length)) throw new DomainError(400, "CSV列数与表头不一致，请使用标准模板");
  return { rows: rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i].trim()]))), lineNumbers,sourceHeaders };
}

function validateRows(data: ImportData, type: DataType, rows: Row[], ctx: ImportContext, sourceSystem: string, lineNumbers: number[],equipmentBinding?:EquipmentProfileBinding,profileData:ImportData=data) {
  const errors: RowError[] = [], validRows: Row[] = []; let duplicates = 0;
  const fields = definitions[type].fields as readonly string[];
  const optionalFields:readonly string[]=type==='DEVICE'?deviceOptionalFields:type==='POINT_DEFINITION'?pointOptionalFields:[];
  const known = effectiveRecords(data).filter(r => r.tenantId === ctx.tenantId);
  const devices = known.filter(r => r.dataType === "DEVICE").map(r => r.value);
  const seen = new Map<string, Row>();
  const existingIntervals = known.filter(r => r.dataType === "STATE_INTERVAL").map(r => r.value);
  const intervals = [...existingIntervals];
  const production = known.filter(r => r.dataType === "PRODUCTION").map(r => r.value);
  let invalid = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], before = errors.length, rowNo = lineNumbers[i] || i + 2;
    const fail = (field: string, code: string, message: string) => errors.push({ row: rowNo, field, code, message });
    for (const field of Object.keys(row)) if (!fields.includes(field)) fail(field, "UNKNOWN_FIELD", "未知列或保留字段，不允许写入");
    for (const field of fields) if (field !== "reason_code" && !optionalFields.includes(field) && (row[field] === undefined || String(row[field]).trim() === "")) fail(field, "REQUIRED", "必填字段为空");
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== "string" && typeof value !== "number") { fail(key, "INVALID_TYPE", "字段须为文本或有限数值"); continue; }
      if (String(value).length > (key==='profile_values'?30000:2000)) fail(key, "TOO_LONG", "字段长度超过"+(key==='profile_values'?30000:2000)+"字符");
      if (typeof value === "string") row[key] = value.trim();
    }
    try{validateProfileRow(row,type,equipmentBinding);}catch(e){fail('profile_values','EQUIPMENT_PROFILE_INVALID',e instanceof Error?e.message:'类型字段无效');}
    for (const field of ["source_record_id", "device_code", "site_code", "line_code"].filter(f => fields.includes(f))) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(row[field] || ""))) fail(field, "INVALID_CODE", "编码仅允许字母、数字、点、下划线和短横线");
    if (type === "DEVICE") {
      if(ctx.authMode==='oidc'&&!scopeAllows(ctx,row)) fail('site_code','OUT_OF_SCOPE','设备不在当前账号授权的数据范围内');
      if (ctx.authMode!=='oidc'&&(row.site_code !== "FACTORY-01" || row.line_code !== "LINE-01")) fail("site_code", "OUT_OF_SCOPE", "文件演示授权范围为 FACTORY-01 / LINE-01；真实平台当前为企业级授权");
      if(row.criticality&&!['LOW','MEDIUM','HIGH','CRITICAL'].includes(String(row.criticality)))fail('criticality','INVALID_CRITICALITY','关键度须为LOW/MEDIUM/HIGH/CRITICAL');
      const other = known.find(r => r.dataType === "DEVICE" && r.value.device_code === row.device_code && (r.value.source_record_id !== row.source_record_id || r.sourceSystem !== sourceSystem));
      if (other) fail("device_code", "DEVICE_CONFLICT", "此设备编码已关联另一来源记录");
      if (validRows.some(d => d.device_code === row.device_code && d.source_record_id !== row.source_record_id)) fail("device_code", "DEVICE_CONFLICT", "批次内设备编码重复");
    } else if (!devices.some(d => d.device_code === row.device_code)) fail("device_code", "UNKNOWN_DEVICE", "请先上传并批准该设备台账");
    else { const asset=devices.find(d=>d.device_code===row.device_code); if(ctx.authMode==='oidc'&&!scopeAllows(ctx,asset||{})){ fail('device_code','OUT_OF_SCOPE','设备不在当前账号授权的数据范围内');invalid++;continue; } }
    const time = (field: string) => {
      const value = String(row[field] || "");
      const ms = Date.parse(value);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(ms)) fail(field, "INVALID_TIME", "时间必须有效且含时区，如 2026-10-13T08:00:00+08:00");
      else {
        const date = value.slice(0, 10); const parsed = new Date(date + "T00:00:00Z");
        if (parsed.toISOString().slice(0, 10) !== date) fail(field, "INVALID_TIME", "日期不存在");
      }
      return ms;
    };
    const number = (field: string, min?: number, integer = false) => {
      const value = Number(row[field]);
      if (row[field] === "" || row[field] === undefined || !Number.isFinite(value) || (min !== undefined && value < min) || (integer && !Number.isInteger(value))) fail(field, "INVALID_NUMBER", "数值无效或不满足取值范围");
      else row[field] = value;
      return value;
    };
    if(type==='POINT_DEFINITION'&&equipmentBinding){
      const asset=known.find(r=>r.dataType==='DEVICE'&&r.value.device_code===row.device_code),assetBinding=profileData.batches.find(b=>b.batchId===asset?.batchId&&b.tenantId===ctx.tenantId)?.equipmentProfileBinding;
      if(!assetBinding||assetBinding.resolution.profile.typeCode!==equipmentBinding.resolution.profile.typeCode)fail('device_code','EQUIPMENT_PROFILE_TYPE_MISMATCH','设备须先批准同类型配置的台账');
      else try{validateProfileRow(structuredClone(asset!.value),'DEVICE',equipmentBinding);}catch(e){fail('device_code','EQUIPMENT_PROFILE_ASSET_INVALID',e instanceof Error?e.message:'设备扩展属性与新版不兼容');}
    }
    if(type==='POINT_DEFINITION'){
      if(!/^[a-z][a-z0-9_]{0,63}$/.test(String(row.tag_code||''))||['__proto__','prototype','constructor'].includes(String(row.tag_code)))fail('tag_code','INVALID_TAG','测点编码须为小写字母开头、数字或下划线，最长64字符；不能使用保留名称');
      if(String(row.unit||'').length>32||/[\u0000-\u001f]/.test(String(row.unit||'')))fail('unit','INVALID_UNIT','单位须为1至32字符的普通文本');
      const min=number('min_value'),max=number('max_value');if(min>=max)fail('max_value','INVALID_RANGE','物理范围上限须大于下限，不是健康阈值');
      if(row.expected_interval_seconds!==undefined&&row.expected_interval_seconds!==''){const interval=number('expected_interval_seconds',1,true);if(interval>31536000)fail('expected_interval_seconds','INVALID_INTERVAL','记录间隔不能超过一年');}
      if(!legacyPointCompatible(row))fail('tag_code','RESERVED_ANALYSIS_TAG','此编码用于旧工程样板，不能改其单位/范围；请使用独立测点编码');
      const conflict=known.some(r=>r.dataType==='POINT_DEFINITION'&&r.value.device_code===row.device_code&&r.value.tag_code===row.tag_code&&(r.value.source_record_id!==row.source_record_id||r.sourceSystem!==sourceSystem))||validRows.some(r=>r.device_code===row.device_code&&r.tag_code===row.tag_code&&r.source_record_id!==row.source_record_id);
      if(conflict)fail('tag_code','POINT_DEFINITION_CONFLICT','本设备测点已关联另一来源定义；请更正原定义，不能新增来源记录覆盖');
    } else if (type === "PRODUCTION") {
      const start = time("period_start"), end = time("period_end"), planned = number("planned_minutes", 0), total = number("total_count", 0, true), good = number("good_count", 0, true), cycle = number("ideal_cycle_seconds", 0);
      if (end <= start || planned <= 0 || planned > (end - start) / 60000) fail("planned_minutes", "INVALID_WINDOW", "计划时长应大于0且不超过有效统计窗口");
      if (good > total) fail("good_count", "INVALID_COUNT", "良品数不能大于总产量");
      if (cycle <= 0) fail("ideal_cycle_seconds", "INVALID_CYCLE", "理想节拍应大于0");
    } else if (type === "STATE_INTERVAL") {
      const start = time("start_time"), end = time("end_time");
      if (end <= start) fail("end_time", "INVALID_WINDOW", "结束时间必须晚于开始时间");
      if (!["RUNNING", "IDLE", "DOWN"].includes(String(row.state))) fail("state", "INVALID_STATE", "状态必须为 RUNNING / IDLE / DOWN");
      if (row.state === "DOWN" && !row.reason_code) fail("reason_code", "REQUIRED", "停机必须填写原因编码");
    } else if (type === "MAINTENANCE") {
      const failure = time("failure_time"), start = time("repair_start"), end = time("repair_end");
      if (failure > start || end <= start) fail("repair_end", "INVALID_WINDOW", "须满足故障时间≤维修开始<维修结束");
    } else if (type === "QUALITY") {
      time("measured_at"); number("sample_no", 1, true); number("measured_value"); const lsl = number("lsl"), usl = number("usl");
      if (lsl >= usl) fail("usl", "INVALID_LIMIT", "上限必须大于下限");
    } else if (type === "MEASUREMENT") {
      const measured = time("measured_at"), value = number("value");
      const definition = approvedPoint(data,ctx.tenantId,String(row.device_code),String(row.tag_code),known);
      if (!definition) fail("tag_code", "UNKNOWN_TAG", "请先上传并独立批准本设备的测点定义");
      else {
        if (row.unit !== definition.unit) fail("unit", "UNIT_MISMATCH", `测点单位必须是 ${definition.unit}`);
        if (value < definition.min || value > definition.max) fail("value", "OUT_OF_RANGE", "超出测点物理范围");
      }
      if (!["GOOD", "BAD", "UNCERTAIN"].includes(String(row.quality))) fail("quality", "INVALID_QUALITY", "质量须为GOOD/BAD/UNCERTAIN");
      if (measured > Date.now() + 300000) fail("measured_at", "FUTURE_TIME", "测点时间不得超前5分钟以上");
      if (known.some(r=>r.dataType === "MEASUREMENT" && r.value.device_code === row.device_code && r.value.tag_code === row.tag_code && Date.parse(String(r.value.measured_at)) === measured && (r.value.source_record_id !== row.source_record_id || r.sourceSystem !== sourceSystem)) || validRows.some(r=>r.device_code === row.device_code && r.tag_code === row.tag_code && Date.parse(String(r.measured_at)) === measured && r.source_record_id !== row.source_record_id)) fail("measured_at", "DUPLICATE_POINT", "同设备测点时间已存在，禁止多来源重复计入");
    }
    if (errors.length > before) { invalid++; continue; }
    const key = String(row.source_record_id);
    const prior = known.find(r => r.dataType === type && r.sourceSystem === sourceSystem && r.value.source_record_id === key)?.value || seen.get(key);
    if (prior) {
      if (canonical(prior) === canonical(row)) { duplicates++; continue; }
      fail("source_record_id", "RECORD_CONFLICT", "相同业务ID内容不同，请使用显式更正批次并独立审批；普通上传不能覆盖"); invalid++; continue;
    }
    if (type === "STATE_INTERVAL" && intervals.some(r => r.device_code === row.device_code && Date.parse(String(r.start_time)) < Date.parse(String(row.end_time)) && Date.parse(String(r.end_time)) > Date.parse(String(row.start_time)))) {
      fail("start_time", "INTERVAL_OVERLAP", "同设备状态区间重叠"); invalid++; continue;
    }
    if (type === "PRODUCTION" && production.some(r => r.device_code === row.device_code && Date.parse(String(r.period_start)) < Date.parse(String(row.period_end)) && Date.parse(String(r.period_end)) > Date.parse(String(row.period_start)))) {
      fail("period_start", "PERIOD_OVERLAP", "同设备班次生产窗口重叠"); invalid++; continue;
    }
    seen.set(key, row); validRows.push(row);
    if (type === "STATE_INTERVAL") intervals.push(row);
    if (type === "PRODUCTION") production.push(row);
  }
  return { errors, validRows, counts: { total: rows.length, valid: validRows.length, invalid, duplicates, committed: 0 } };
}

function checkCorrectionDependencies(data:ImportData,type:DataType,rows:Row[],binding:CorrectionBinding,ctx:ImportContext,sourceSystem:string){
  if(type!=='POINT_DEFINITION'&&type!=='DEVICE')return;
  const proposed=withoutCorrectionTargets(data,binding,ctx.tenantId,sourceSystem,type),devices=new Set(rows.map(r=>r.device_code));
  proposed.records.push(...rows.map((value,i)=>({tenantId:ctx.tenantId,dataType:type,sourceSystem,batchId:'proposed',row:i+2,value})));
  const affected=proposed.records.filter(r=>r.tenantId===ctx.tenantId&&r.dataType==='MEASUREMENT'&&devices.has(r.value.device_code));
  for(const source of new Set(affected.map(r=>r.sourceSystem))){
    const checked=validateRows(proposed,'MEASUREMENT',structuredClone(affected.filter(r=>r.sourceSystem===source).map(r=>r.value)),ctx,source,[]);
    if(checked.counts.invalid)throw new DomainError(409,'更正会使现有测点记录不符合授权、单位或物理范围，须先处理依赖数据');
  }
}

export function createBatch(data: ImportData, store: Store, input: { dataType: unknown; templateVersion: unknown; sourceSystem: unknown; rows: Row[]; original: Buffer; filename: string; mime: string; sourceKind: string; aiMode?: string; lineNumbers?: number[];mappingRef?:unknown;sourceHeaders?:string[];supersedesBatchId?:unknown;correctionReason?:unknown;equipmentProfileRef?:unknown;profileDeviceCode?:string }, ctx: ImportContext): Batch {
  authorize(ctx, "upload");
  const type = String(input.dataType) as DataType;
  if (!Object.hasOwn(definitions, type)) throw new DomainError(400, "数据类型不支持");
  if (input.templateVersion !== "1.0.0") throw new DomainError(400, "演示版模板版本为1.0.0");
  if (typeof input.sourceSystem !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(input.sourceSystem)) throw new DomainError(400, "来源系统须为1–100位标准编码");
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 10000 || input.rows.some(r => !r || typeof r !== "object" || Array.isArray(r))) throw new DomainError(400, "上传须含1–10000条有效结构的记录");
  if (data.batches.filter(b => b.tenantId === ctx.tenantId).length >= 100) throw new DomainError(429, "演示最多保存100个批次，可导出后重置");
  const mappingBinding=input.mappingRef===undefined?undefined:bindImportMapping(store,input.mappingRef,ctx.tenantId,type,input.sourceSystem);
  if(mappingBinding&&(!['MANUAL_FILE','API_FILE'].includes(input.sourceKind)||!input.sourceHeaders))throw new DomainError(400,'映射仅支持带原表头的文件上传');
  const rows = mappingBinding?mapRows(structuredClone(input.rows),input.sourceHeaders!,mappingBinding.mapping):structuredClone(input.rows);
  const inherited=inheritedProfileBinding(data,ctx.tenantId,input.supersedesBatchId,store),equipmentBinding=input.profileDeviceCode!==undefined?equipmentBindingForDevice(store,data,input.profileDeviceCode,ctx):input.equipmentProfileRef===undefined?inherited?structuredClone(inherited):undefined:bindEquipmentProfile(store,input.equipmentProfileRef,ctx.tenantId);
  if(input.profileDeviceCode!==undefined&&(type!=='POINT_DEFINITION'||input.equipmentProfileRef!==undefined||rows.some(r=>r.device_code!==input.profileDeviceCode)))throw new DomainError(400,'设备生成配置不能混入其他类型、设备或引用');
  prepareProfileRows(rows,type,equipmentBinding,inherited);
  let correction=bindCorrection(data,ctx,type,input.sourceSystem,rows,input.supersedesBatchId,input.correctionReason);
  const result = validateRows(correction?withoutCorrectionTargets(data,correction,ctx.tenantId,input.sourceSystem,type):data, type, rows, ctx, input.sourceSystem, input.lineNumbers || [],equipmentBinding,data);
  if(correction&&!result.counts.invalid){correction=bindCorrection(data,ctx,type,input.sourceSystem,rows,input.supersedesBatchId,input.correctionReason);checkCorrectionDependencies(data,type,rows,correction!,ctx,input.sourceSystem);}
  if(mappingBinding)for(const e of result.errors)e.sourceField=mappingBinding.mapping.columns.find(c=>c.targetField===e.field)?.sourceColumn||e.field;
  const mode = input.aiMode || "demo";
  if (!["demo", "unavailable", "gateway"].includes(mode)) throw new DomainError(400, "AI审核模式无效");
  const injection = rows.some(r => Object.values(r).some(v => suspiciousInstruction(String(v))));
  const fallback = mode === "unavailable" || injection;
  const now = new Date().toISOString();
  const batch: Batch = {
    batchId: randomUUID(), tenantId: ctx.tenantId, dataType: type, status: result.counts.invalid ? "VALIDATION_FAILED" : fallback ? "HUMAN_REVIEW" : mode==='gateway' ? 'AI_PENDING' : "AWAITING_APPROVAL", version: 1,
    createdAt: now, correlationId: ctx.correlationId, uploader: ctx.actorId, sourceSystem: input.sourceSystem, sourceKind: input.sourceKind, filename: input.filename.slice(0, 200), templateVersion: "1.0.0",
    fileSha256: digest(input.original), snapshotDigest: digest(canonical({ rows, templateVersion: "1.0.0", ruleVersion: "upload-rules-1.0.0", sourceSystem: input.sourceSystem, dataType: type })),
    originalBase64: input.original.toString("base64"), mime: input.mime, rows, lineNumbers: input.lineNumbers || rows.map((_, i) => i + 2), ...result,
    aiReview: { status: result.counts.invalid ? "PENDING" : fallback ? "HUMAN_REQUIRED" : mode==='gateway'?'PENDING':'AUTO_REVIEWED', confidence: null,
      conclusion: result.counts.invalid ? "请先修正确定性校验错误" : fallback ? (injection ? "材料存在可疑指令内容，转人工复核" : "真实模型未连接，已转人工复核") : mode==='gateway'?'等待本地真实模型影子审阅；不能在处理期间批准':'模拟 AI：材料字段完整，已整理批准包；需独立人员终审',
      evidence: [`来源：${input.sourceSystem}`, `原始记录 ${rows.length} 行；有效 ${result.counts.valid}；重复 ${result.counts.duplicates}`, "模板1.0.0 / 规则upload-rules-1.0.0", "原始输入与逐行校验已冻结"], modelVersion: fallback ? "unavailable" : mode==='gateway'?'PENDING-LOCAL-MODEL':"DEMO-RULE-REVIEW-1.0" }, reportStatus: "NOT_SCHEDULED"
  };
  if(mappingBinding){batch.mappingBinding=mappingBinding;batch.sourceHeaders=[...input.sourceHeaders!];batch.snapshotDigest=mappedSnapshotDigest(batch);}
  if(correction)batch.correction=correction;
  if(equipmentBinding)batch.equipmentProfileBinding=equipmentBinding;
  if(correction||equipmentBinding)batch.snapshotDigest=batchInputDigest(batch);
  data.batches.push(batch);
  appendAudit(store, { tenantId: ctx.tenantId, objectType: "DATA_IMPORT", objectId: batch.batchId, action: "IMPORT_RECEIVED", actorType: ctx.actorType as "USER", actorId: ctx.actorId, correlationId: ctx.correlationId, metadata: { fileSha256: batch.fileSha256, filename: batch.filename, snapshotDigest: batch.snapshotDigest, dataType: type, counts: batch.counts,...(equipmentBinding?{equipmentProfileBinding:equipmentBinding}:{}),...(correction?{correction}:{}),...(mappingBinding?{mappingBinding,sourceHeaders:batch.sourceHeaders}: {}) } });
  appendAudit(store, { tenantId: ctx.tenantId, objectType: "DATA_IMPORT", objectId: batch.batchId, action: result.counts.invalid ? "IMPORT_VALIDATION_FAILED" : fallback ? "IMPORT_HUMAN_REVIEW_REQUIRED" : mode==='gateway'?'IMPORT_AI_PENDING':"IMPORT_DEMO_AI_REVIEWED", actorType: fallback || result.counts.invalid || mode==='gateway' ? "RULE" : "AI", actorId: mode==='gateway'?'idms.import-validation':"demo.rules", correlationId: ctx.correlationId, metadata: { ...batch.aiReview, counts: batch.counts } });
  return batch;
}

export function approveBatch(data: ImportData, store: Store, id: string, input: Record<string, unknown>, ctx: ImportContext): Batch {
  authorize(ctx, "approve"); const batch = getBatch(data, id, ctx);
  if (ctx.actorId === batch.uploader) throw new DomainError(403, "上传者不能终审本人的批次");
  if (!["AWAITING_APPROVAL", "HUMAN_REVIEW"].includes(batch.status)) throw new DomainError(409, "此批次不处于可终审状态");
  if (input.expectedVersion !== batch.version || input.snapshotDigest !== batch.snapshotDigest) throw new DomainError(409, "批次版本或快照已变化，请刷新后重新审核");
  verifyBatchMapping(store,batch);
  const decision = String(input.decision);
  if (!["APPROVED", "RETURNED", "REJECTED"].includes(decision)) throw new DomainError(400, "审批决定无效");
  const comment = String(input.comment || "").trim(), reviewResolution = String(input.reviewResolution || "").trim();
  if (comment.length < 2 || comment.length > 2000) throw new DomainError(400, "审批意见须为2–2000字符");
  if (decision === "APPROVED" && batch.status === "HUMAN_REVIEW" && reviewResolution.length < 2) throw new DomainError(400, "转人工批次必须填写复核依据");
  const before = { status: batch.status, version: batch.version };
  let toCommit: Row[] = [];
  if (decision === "APPROVED") {
    // Recheck against current committed master data before performing any write.
    let validationData=data;
    if(batch.correction){
      const latest=bindCorrection(data,ctx,batch.dataType,batch.sourceSystem,batch.rows,batch.correction.supersedesBatchId,batch.correction.reason);
      if(canonical(latest)!==canonical(batch.correction))throw new DomainError(409,'更正基准版本已变化，请重新提交更正');
      validationData=withoutCorrectionTargets(data,batch.correction,ctx.tenantId,batch.sourceSystem,batch.dataType);
    }
    const recheck = validateRows(validationData, batch.dataType, structuredClone(batch.rows), ctx, batch.sourceSystem, [],batch.equipmentProfileBinding,data);
    if(batch.correction&&!recheck.counts.invalid)checkCorrectionDependencies(data,batch.dataType,recheck.validRows,batch.correction,ctx,batch.sourceSystem);
    if (recheck.counts.invalid) throw new DomainError(409, "数据或主数据产生并发冲突，请作为新批次重新校验");
    toCommit = recheck.validRows; batch.counts = recheck.counts;
  }
  batch.approval = { decision, comment, approver: ctx.actorId, decidedAt: new Date().toISOString(), reviewResolution };
  batch.version++;
  if (reviewResolution) appendAudit(store, { tenantId: ctx.tenantId, objectType: "DATA_IMPORT", objectId: id, action: "IMPORT_HUMAN_REVIEWED", actorType: "USER", actorId: ctx.actorId, correlationId: ctx.correlationId, metadata: { reviewResolution, snapshotDigest: batch.snapshotDigest } });
  appendAudit(store, { tenantId: ctx.tenantId, objectType: "DATA_IMPORT", objectId: id, action: `IMPORT_HUMAN_${decision}`, actorType: "USER", actorId: ctx.actorId, correlationId: ctx.correlationId, before, metadata: { ...batch.approval, snapshotDigest: batch.snapshotDigest } });
  if (decision === "APPROVED") {
    if(!batch.correction)data.records.push(...toCommit.map(row => { const index = batch.rows.findIndex(r => r.source_record_id === row.source_record_id); return { tenantId: ctx.tenantId, sourceSystem: batch.sourceSystem, dataType: batch.dataType, batchId: id, row: batch.lineNumbers?.[index] ?? index + 2, value: structuredClone(row) }; }));
    batch.counts.committed = toCommit.length; batch.status = "COMMITTED"; batch.committedAt = new Date().toISOString(); batch.reportStatus = "READY";
    appendAudit(store, { tenantId: ctx.tenantId, objectType: "DATA_IMPORT", objectId: id, action: "IMPORT_COMMITTED", actorType: "SYSTEM", actorId: "demo.import-service", correlationId: ctx.correlationId, metadata: { committed: toCommit.length, duplicates: batch.counts.duplicates, snapshotDigest: batch.snapshotDigest } });
  } else batch.status = decision;
  return batch;
}

export function report(data: ImportView, tenantId: string,ctx?:AccessContext) {
  const view=ctx?dataScope(data,ctx):null;
  const rows = effectiveRecords(data).filter(r => r.tenantId === tenantId&&(!view||view.row(r))), batches = data.batches.filter(b => b.tenantId === tenantId&&(!view||view.batch(b)));
  const get = (type: DataType) => rows.filter(r => r.dataType === type).map(r => r.value);
  const production = get("PRODUCTION"), states = get("STATE_INTERVAL"), quality = get("QUALITY"), repairs = get("MAINTENANCE"), assets = get("DEVICE");
  const intervals = (device: string, start: number, end: number) => states.filter(s => s.device_code === device).map(s => ({ start: Math.max(start, Date.parse(String(s.start_time))), end: Math.min(end, Date.parse(String(s.end_time))), state: s.state })).filter(s => s.end > s.start).sort((a, b) => a.start - b.start);
  const performance = production.map(p => {
    const start = Date.parse(String(p.period_start)), end = Date.parse(String(p.period_end)), span = intervals(String(p.device_code), start, end);
    const covered = span.reduce((sum, s) => sum + s.end - s.start, 0), runningSeconds = span.filter(s => s.state === "RUNNING").reduce((sum, s) => sum + (s.end - s.start) / 1000, 0);
    let issue = covered !== end - start ? "状态区间覆盖不完整" : Number(p.planned_minutes) * 60000 !== end - start ? "班次含非生产时间，需配置计划子窗口" : !runningSeconds || !Number(p.total_count) ? "无运行时间或产量" : "";
    const a = runningSeconds / (Number(p.planned_minutes) * 60), perf = Number(p.ideal_cycle_seconds) * Number(p.total_count) / runningSeconds, q = Number(p.good_count) / Number(p.total_count);
    if (!issue && (a > 1 || perf > 1)) issue = "节拍或运行时间冲突，需核查";
    return { ...p, availability: issue ? null : a * 100, performance: issue ? null : perf * 100, quality: Number(p.total_count) ? q * 100 : null, oee: issue ? null : a * perf * q * 100, issue, runningMinutes: runningSeconds / 60 };
  });
  const total = production.reduce((s, r) => s + Number(r.total_count), 0), good = production.reduce((s, r) => s + Number(r.good_count), 0);
  const downMinutes = states.filter(s => s.state === "DOWN").reduce((s, r) => s + (Date.parse(String(r.end_time)) - Date.parse(String(r.start_time))) / 60000, 0);
  const mttr = repairs.length ? repairs.reduce((s, r) => s + (Date.parse(String(r.repair_end)) - Date.parse(String(r.repair_start))) / 60000, 0) / repairs.length : null;
  const times = rows.flatMap(r => [r.value.period_end, r.value.end_time, r.value.repair_end, r.value.measured_at]).filter(Boolean).map(String).sort((a, b) => Date.parse(b) - Date.parse(a));
  const reasons = Object.entries(states.filter(s => s.state === "DOWN").reduce((map: Record<string, number>, r) => { const key = String(r.reason_code); map[key] = (map[key] || 0) + (Date.parse(String(r.end_time)) - Date.parse(String(r.start_time))) / 60000; return map; }, {})).map(([reason, minutes]) => ({ reason, minutes }));
  return { assets, production: performance, states, repairs, quality, reasons, total, good, yield: total ? good / total * 100 : null, downMinutes, mttr, qualitySamples: quality.length, cpk: null, cpkIssue: "演示暂不计算过程能力；需要同特性≥30个有效样本及稳定性验证", dataAsOf: times[0] || null, lastUploadAt: batches.at(-1)?.createdAt || null, committedRows: rows.length, committedBatches: batches.filter(b => b.status === "COMMITTED").length, pending: batches.filter(b => ["AWAITING_APPROVAL", "HUMAN_REVIEW"].includes(b.status)).length, invalid: batches.filter(b => b.status === "VALIDATION_FAILED").length };
}
