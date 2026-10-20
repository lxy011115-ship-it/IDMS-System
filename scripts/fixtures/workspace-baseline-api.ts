// Frozen pre-workspace implementation for isolated capacity comparison only.
if(!process.send||!/^workspaceqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned workspace QA IPC required');
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "../../server/store.ts";
import { loadPredictive } from "../../server/predictive-persistence.ts";
import { loadPostgres, savePostgres, storageMode, tenantTransaction,tenantLockedRead } from "./workspace-baseline-repository.ts";
import {tenantPayload,readEntities,type TenantPayload} from './workspace-baseline-entities.ts';
import {verifiedReadStamp} from '../../server/read-integrity.ts';
import type pg from 'pg';
import type { PlatformSnapshot } from "./workspace-baseline-repository.ts";
import { DomainError } from "../../server/service.ts";
import { verifyAuditChain } from "../../server/audit.ts";
import { emptyImports, definitions, digest, canonical, authorize, createBatch, approveBatch, present, getBatch, report, parseCsv } from "../../server/imports.ts";
import type { ImportContext, ImportData, Row, Batch } from "../../server/imports.ts";
import type { AiImportService } from '../../server/ai-import-review.ts';
import {validateHeaders} from '../../server/import-mapping.ts';
import {verifyBatchMapping} from '../../server/catalog.ts';
import {verifyEquipmentCatalog} from '../../server/equipment-profiles.ts';
import {dataScope} from '../../server/data-scope.ts';
import {correctionReviewCsv} from '../../server/correction-review.ts';

const namespace = process.env.IDMS_DEMO_NAMESPACE || "local";
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(namespace)) throw new Error("演示存储命名空间无效");
const directory = join(process.cwd(), ".demo-data", namespace);
const snapshotFile = join(directory, "imports.json");
export let importData: ImportData = emptyImports();
let queue: Promise<unknown> = Promise.resolve();
const appliedReads=new WeakMap<Store,Map<string,string>>();
function freezeReadValues(value:unknown):void{
 if(!value||typeof value!=='object'||Object.isFrozen(value))return;
 if(value instanceof Map){for(const item of value.values())freezeReadValues(item);return;}
 for(const item of Object.values(value))freezeReadValues(item);Object.freeze(value);
}
export async function loadImports(store: Store) {
  if(storageMode!=='postgres-tenant-databases'){
  try {
    const saved = JSON.parse(await readFile(snapshotFile, "utf8"));
    if (![1, 2].includes(saved.version) || !Array.isArray(saved.imports?.batches) || !Array.isArray(saved.imports?.records) || !Array.isArray(saved.imports?.requests) || !Array.isArray(saved.audits)) throw new Error("存储格式错误");
    for (const tenant of store.tenants) if (!verifyAuditChain(saved.audits, tenant.id)) throw new Error("审计链校验失败");
    importData = saved.imports; store.audits = saved.audits;
    if (saved.version === 2) {
      for (const key of Object.keys(store).filter(k => !["audits", "idempotency"].includes(k))) {
        if (!Array.isArray(saved.business?.[key])) throw new Error(`业务快照缺少 ${key}`);
        (store as unknown as Record<string, unknown>)[key] = saved.business[key];
      }
      if (!Array.isArray(saved.idempotency)) throw new Error("幂等记录格式错误");
      store.idempotency = new Map(saved.idempotency);
    } else {
      await loadPredictive(store);
      // Old code claimed a work order without creating one: do not preserve a false completed action.
      for (const alert of store.predictiveAlerts) {
        alert.version ??= 1;
        if (alert.state === "WORK_ORDER_CREATED" && !alert.workOrderId) {
          alert.state = "AWAITING_APPROVAL";
          delete alert.approvedAt; delete alert.approvedBy; delete alert.approvalComment;
          const recommendation = store.maintenanceRecommendations.find(r => r.alertId === alert.id && r.tenantId === alert.tenantId);
          if (recommendation) recommendation.status = "PROPOSED";
        }
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`演示数据加载失败，请检查 .demo-data/imports.json：${(error as Error).message}`); }
  }
  if (storageMode === "postgres-tenant-databases") {
    const loaded = await loadPostgres(platformSnapshot(store));
    for (const tenant of loaded.business.tenants) if (!verifyAuditChain(loaded.audits, tenant.id)) throw new Error("数据库审计链校验失败");
    importData = loaded.imports;
    Object.assign(store, loaded.business, {audits:loaded.audits,idempotency:new Map(loaded.idempotency)});
  }
  verifyEquipmentCatalog(store);for(const batch of importData.batches)verifyBatchMapping(store,batch);
}
export function platformSnapshot(store: Store): PlatformSnapshot {
  const {audits,idempotency,...business}=store;
  return {version:2, imports:importData, audits, business, idempotency:[...idempotency]};
}
function applyTenant(store:Store,tenantId:string,payload:TenantPayload){
 payload=structuredClone(payload);
 if(payload.business.tenants.length!==1||payload.business.tenants[0].status!=='ACTIVE')throw new DomainError(403,'企业不存在或已停用');
 for(const [key,items]of Object.entries(payload.business))(store as any)[key]=[...(store as any)[key].filter((item:any)=>key==='tenants'?item.id!==tenantId:item.tenantId!==tenantId),...items];
 for(const key of ['batches','records'] as const)importData[key]=[...importData[key].filter(r=>r.tenantId!==tenantId),...payload.imports[key]] as never;
 importData.requests=[...importData.requests.filter(r=>!r.key.startsWith(tenantId+':')),...payload.imports.requests];
 store.audits=[...store.audits.filter(a=>a.tenantId!==tenantId),...payload.audits];store.idempotency=new Map([...store.idempotency].filter(([key])=>!key.startsWith(tenantId+':')).concat(payload.idempotency));
}
export function consistentRead<T>(store:Store,tenantId:string,read:()=>Promise<T>):Promise<T>{
 const run=queue.then(()=>storageMode==='postgres-tenant-databases'?tenantLockedRead(tenantId,async(client,pool)=>{
  let loaded:TenantPayload|undefined;const stamp=await verifiedReadStamp(pool,client,tenantId,payload=>{loaded=payload;},true);let applied=appliedReads.get(store);
  if(applied?.get(tenantId)!==stamp){
   applyTenant(store,tenantId,loaded||(await readEntities(client,tenantId)).payload);
   for(const value of Object.values(store))freezeReadValues(value);for(const value of Object.values(importData))freezeReadValues(value);
   if(!applied){applied=new Map();appliedReads.set(store,applied);}applied.set(tenantId,stamp);
  }
  return read();
 }):read());
 queue=run.then(()=>undefined,()=>undefined);return run;
}
export async function mutate<T>(store: Store, task: (client?:pg.PoolClient) => T | Promise<T>, tenantId?:string): Promise<T> {
  const run = queue.then(async () => {
    // A failed command may also have touched working objects; no read proof may
    // reuse that working copy until a fresh verified snapshot is applied.
    appliedReads.delete(store);
    let oldData = structuredClone(importData), oldStore = structuredClone(store);
    try {
      if(storageMode==='postgres-tenant-databases'){
        if(!tenantId)throw new DomainError(503,'数据库写入必须指定企业事务');
        return await tenantTransaction(tenantId,async tx=>{
          applyTenant(store,tenantId,tx.payload);oldData=structuredClone(importData);oldStore=structuredClone(store);const before=platformSnapshot(store),result=await task(tx.client),after=platformSnapshot(store);
          for(const tenant of before.business.tenants)if(tenant.id!==tenantId&&canonical(tenantPayload(before,tenant.id))!==canonical(tenantPayload(after,tenant.id)))throw new DomainError(409,'单次事务不得修改其他企业');
          await savePostgres(after,tx);return result;
        });
      }
      if(tenantId)throw new DomainError(503,'遥测事务要求PostgreSQL');
      const result = await task();
      {
        await mkdir(directory, { recursive: true });
        await writeFile(snapshotFile + ".tmp", JSON.stringify(platformSnapshot(store)), "utf8");
        await rename(snapshotFile + ".tmp", snapshotFile);
      }
      return result;
    } catch (e) { importData = oldData; Object.assign(store, oldStore); throw e; }
  });
  queue = run.then(() => undefined, () => undefined); return run;
}
export function clearImports(store: Store, tenantId: string) {
    const ids = new Set(importData.batches.filter(b => b.tenantId === tenantId).map(b => b.batchId));
    importData.batches = importData.batches.filter(b => b.tenantId !== tenantId);
    importData.records = importData.records.filter(r => r.tenantId !== tenantId);
    importData.requests = importData.requests.filter(r => !ids.has(r.batchId));
    store.audits = store.audits.filter(a => a.tenantId !== tenantId);
}
export async function waitForWrites() { await queue; }

export async function transactionalRequest<T>(store: Store, key: string, hash: string, task: (client?:pg.PoolClient) => T | Promise<T>, tenantId?:string,authorizeReceipt?:()=>void) {
  return mutate(store, async client => {
    authorizeReceipt?.();
    const prior = store.idempotency.get(key) as { digest: string; response: T } | undefined;
    if (prior) {
      if (prior.digest !== hash) throw new DomainError(409, "相同幂等键对应不同请求");
      return structuredClone(prior.response);
    }
    const result = await task(client);
    store.idempotency.set(key, { digest: hash, response: structuredClone(result) });
    return structuredClone(result);
  },tenantId);
}
async function bytes(req: IncomingMessage, max: number) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new DomainError(413, "上传超过大小限制"); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
function reply(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(payload));
}
function attachment(res: ServerResponse, data: Buffer | string, mime: string, filename: string) {
  res.writeHead(200, { "content-type": mime, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(data);
}
function allowedKeys(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).some(k => !keys.includes(k))) throw new DomainError(400, "存在未知或保留字段；请使用当前接口支持的字段");
}
// Check central-directory size declarations before allowing XLSX decompression.
function inspectZip(buffer: Buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new DomainError(415, "不是有效XLSX文件");
  const count = buffer.readUInt16LE(eocd + 10); let offset = buffer.readUInt32LE(eocd + 16), expanded = 0;
  if (count > 1000 || count === 65535) throw new DomainError(413, "Excel包含过多归档项目");
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new DomainError(415, "Excel归档目录无效");
    expanded += buffer.readUInt32LE(offset + 24);
    const length = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + length).toString("utf8");
    if (/vbaProject|externalLinks/i.test(name) || name.includes("..")) throw new DomainError(415, "不允许宏或外部链接");
    if (expanded > 50 * 1024 * 1024) throw new DomainError(413, "Excel展开内容超过50 MiB");
    offset += 46 + length + extra + comment;
  }
}
async function parseXlsx(buffer: Buffer,mapped=false): Promise<{ rows: Row[]; lineNumbers: number[];sourceHeaders:string[] }> {
  inspectZip(buffer);
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer as never); } catch { throw new DomainError(415, "Excel无法读取，请上传未加密的标准XLSX"); }
  const sheet = workbook.getWorksheet("data");
  if (!sheet || workbook.worksheets.length !== 1) throw new DomainError(400, "Excel必须只有一个名为data的数据工作表");
  if (sheet.rowCount > 10001 || sheet.rowCount * sheet.columnCount > 100000) throw new DomainError(413, "Excel行数或单元格超限");
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, cell => {if(cell.value&&typeof cell.value==='object')throw new DomainError(400,'Excel表头禁止公式和链接');headers.push(String(cell.value??''));});
  const sourceHeaders=[...headers],names=validateHeaders(headers,mapped);
  const rows: Row[] = [], lineNumbers: number[] = [];
  for (let n = 2; n <= sheet.rowCount; n++) {
    const row: Row = {}; let nonempty = false;
    for (let col = 1; col <= sheet.columnCount; col++) {
      const value = sheet.getRow(n).getCell(col).value;
      if (value && typeof value === "object") throw new DomainError(400, `第${n}行请使用纯文本或数值，禁止公式/链接；日期须为含时区文本`);
      if (col > headers.length && value !== null) throw new DomainError(400, "Excel数据超出表头范围");
      if (col <= headers.length) Object.defineProperty(row,names[col-1],{value:typeof value==='number'?value:String(value??''),enumerable:true,writable:true,configurable:true});
      if (value !== null && value !== "") nonempty = true;
    }
    if (nonempty) { rows.push(row); lineNumbers.push(n); }
  }
  return { rows, lineNumbers,sourceHeaders };
}

export async function importApi(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ImportContext, store: Store, ai?:AiImportService): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/v1/data-import") && path !== "/api/v1/upload-report") return false;
  authorize(ctx, "read");
  if (req.method === "GET" && path === "/api/v1/upload-report") { reply(res, 200, report(importData, ctx.tenantId,ctx)); return true; }
  const template = /^\/api\/v1\/data-import-templates\/([^/]+)$/.exec(path);
  if (req.method === "GET" && template) {
    const definition = definitions[template[1] as keyof typeof definitions];
    if (!definition) throw new DomainError(404, "模板不存在");
    if (url.searchParams.get("version") && url.searchParams.get("version") !== "1.0.0") throw new DomainError(404, "模板版本不存在");
    const file=template[1]==='DEVICE'&&url.searchParams.get('profile')==='extended'?'devices-extended.csv':definition.file;
    const content = await readFile(join(process.cwd(), "docs", "upload-templates", file), "utf8");
    res.setHeader("X-Template-Version", "1.0.0");
    attachment(res, "\uFEFF" + (url.searchParams.get("sample") === "1" ? content : content.split(/\r?\n/)[0] + "\r\n"), "text/csv; charset=utf-8", file); return true;
  }
  if (req.method === "GET" && path === "/api/v1/data-imports") {
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1), pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize")) || 20));
    const scope=dataScope(importData,ctx,store);
    const items = importData.batches.filter(b => scope.batch(b) && (!url.searchParams.get("status") || b.status === url.searchParams.get("status")) && (!url.searchParams.get("dataType") || b.dataType === url.searchParams.get("dataType"))).slice().reverse();
    reply(res, 200, { items: items.slice((page - 1) * pageSize, page * pageSize).map(present), total: items.length, page, pageSize }); return true;
  }
  const match = /^\/api\/v1\/data-imports\/([^/]+)(?:\/(errors|approval|original|correction-review))?$/.exec(path);
  if (req.method === "GET" && match) {
    const batch = getBatch(importData, match[1], ctx);
    if(match[2]==='correction-review')attachment(res,correctionReviewCsv(importData,batch,ctx),'text/csv; charset=utf-8','correction-review.csv');
    else if (match[2] === "original") attachment(res, Buffer.from(batch.originalBase64, "base64"), batch.mime, batch.filename);
    else if (match[2] === "errors") {
      if (url.searchParams.get("format") === "csv") {
        const cell = (value: unknown) => '"' + String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
        attachment(res, "\uFEFF" + [["row", "field", "code", "message",...(batch.mappingBinding?['sourceField']:[])], ...batch.errors.map(e => [e.row, e.field, e.code, e.message,...(batch.mappingBinding?[e.sourceField||e.field]:[])])].map(r => r.map(cell).join(",")).join("\r\n"), "text/csv; charset=utf-8", "errors.csv");
      } else {
        const page = Math.max(1, Number(url.searchParams.get("page")) || 1), pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize")) || 20));
        reply(res, 200, { items: batch.errors.slice((page - 1) * pageSize, page * pageSize), total: batch.errors.length, page, pageSize });
      }
    } else if (!match[2]) reply(res, 200, present(batch));
    else throw new DomainError(405, "审批接口须使用POST");
    return true;
  }
  if (req.method !== "POST" || (path !== "/api/v1/data-imports" && path !== "/api/v1/data-imports/records" && match?.[2] !== "approval")) throw new DomainError(404, "上传接口不存在");
  authorize(ctx, match?.[2] === "approval" ? "approve" : "upload");
  const raw = await bytes(req, path === "/api/v1/data-imports" ? 10 * 1024 * 1024 + 65536 : 1024 * 1024);
  const key = String(req.headers["idempotency-key"] || ""), hash = digest(raw);
  if (key.length < 8 || key.length > 128) throw new DomainError(400, "Idempotency-Key须为8–128字符");
  if (!/^[0-9a-f-]{36}$/i.test(String(req.headers["x-correlation-id"] || ""))) throw new DomainError(400, "写接口需UUID格式X-Correlation-Id");
  const requestKey = `${ctx.tenantId}:${ctx.actorId}:${path}:${key}`;
  let result: Batch;
  if (path === "/api/v1/data-imports") {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.startsWith("multipart/form-data")) throw new DomainError(415, "文件接口需要multipart/form-data");
    let form: FormData;
    try { form = await new Request("http://localhost", { method: "POST", headers: { "content-type": contentType }, body: new Uint8Array(raw) }).formData(); } catch { throw new DomainError(400, "multipart格式错误"); }
    const keys = [...form.keys()];
    if (new Set(keys).size !== keys.length || keys.some(k => !["file", "dataType", "templateVersion", "sourceSystem", "aiMode","mappingRef","supersedesBatchId","correctionReason","equipmentProfileRef"].includes(k))) throw new DomainError(400, "文件参数重复或包含未知/保留字段");
    for(const key of keys.filter(k=>k!=='file'))if(typeof form.get(key)!=='string')throw new DomainError(400,'文件元数据必须为文本');
    let mappingRef:unknown;
    if(form.has('mappingRef')){try{mappingRef=JSON.parse(String(form.get('mappingRef')));}catch{throw new DomainError(400,'mappingRef必须为JSON引用');}if(!mappingRef||typeof mappingRef!=='object'||Array.isArray(mappingRef))throw new DomainError(400,'mappingRef必须为对象引用');}
    let equipmentProfileRef:unknown;if(form.has('equipmentProfileRef')){try{equipmentProfileRef=JSON.parse(String(form.get('equipmentProfileRef')));}catch{throw new DomainError(400,'equipmentProfileRef必须为JSON引用');}}
    const file = form.get("file");
    if (!(file instanceof File) || !file.size || file.size > 10 * 1024 * 1024) throw new DomainError(413, "请选择1字节至10 MiB的CSV/XLSX文件");
    const original = Buffer.from(await file.arrayBuffer());
    const isXlsx = /\.xlsx$/i.test(file.name), isCsv = /\.csv$/i.test(file.name);
    if (!isXlsx && !isCsv) throw new DomainError(415, "仅支持.csv或.xlsx文件");
    let parsed: { rows: Row[]; lineNumbers: number[];sourceHeaders:string[] };
    if (isXlsx) parsed = await parseXlsx(original,mappingRef!==undefined);
    else {
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(original); } catch { throw new DomainError(415, "CSV须为UTF-8编码（Excel另存为CSV UTF-8）"); }
      parsed = parseCsv(text,mappingRef!==undefined);
    }
    const semanticHash = digest(canonical({ file: digest(original), filename: file.name, dataType: form.get("dataType"), templateVersion: form.get("templateVersion"), sourceSystem: form.get("sourceSystem"), aiMode: form.get("aiMode") || "demo",...(mappingRef===undefined?{}:{mappingRef}),...(equipmentProfileRef===undefined?{}:{equipmentProfileRef}),...(form.has('supersedesBatchId')?{supersedesBatchId:form.get('supersedesBatchId')}:{}),...(form.has('correctionReason')?{correctionReason:form.get('correctionReason')}: {}) }));
    result = await mutate(store, async client => {
      const batch=cachedOrCreate(requestKey, semanticHash, ctx, () => createBatch(importData, store, { ...parsed,mappingRef,equipmentProfileRef,supersedesBatchId:form.has('supersedesBatchId')?form.get('supersedesBatchId'):undefined,correctionReason:form.has('correctionReason')?form.get('correctionReason'):undefined, dataType: form.get("dataType"), templateVersion: form.get("templateVersion"), sourceSystem: form.get("sourceSystem"), original, filename: file.name, mime: isXlsx ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8", sourceKind: ctx.actorType === "INTERFACE" ? "API_FILE" : "MANUAL_FILE", aiMode: ai?.mode(String(form.get('aiMode')||'demo'),ctx)||'demo' }, ctx));
      await ai?.enqueue(store,client,batch,ctx);return batch;
    },storageMode==='postgres-tenant-databases'?ctx.tenantId:undefined);
  } else {
    let input: Record<string, unknown>;
    try { input = JSON.parse(raw.toString("utf8")); } catch { throw new DomainError(400, "JSON无效"); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError(400, "JSON须为对象");
    if (match?.[2] === "approval") {
      allowedKeys(input, ["decision", "comment", "expectedVersion", "snapshotDigest", "reviewResolution"]);
      result = await mutate(store, () => cachedOrCreate(requestKey, hash, ctx, () => approveBatch(importData, store, match[1], input, ctx)),storageMode==='postgres-tenant-databases'?ctx.tenantId:undefined);
    } else {
      allowedKeys(input, ["dataType", "templateVersion", "sourceSystem", "records", "aiMode", "supersedesBatchId", "correctionReason", "equipmentProfileRef"]);
      if (!Array.isArray(input.records) || input.records.length > 500) throw new DomainError(413, "JSON每请求最多500条记录");
      result = await mutate(store, async client=>{
        const batch=cachedOrCreate(requestKey, hash, ctx, () => createBatch(importData, store, { equipmentProfileRef:input.equipmentProfileRef,supersedesBatchId:input.supersedesBatchId,correctionReason:input.correctionReason,dataType: input.dataType, templateVersion: input.templateVersion, sourceSystem: input.sourceSystem, rows: input.records as Row[], original: raw, filename: "records.json", mime: "application/json", sourceKind: "API_JSON", aiMode: ai?.mode(String(input.aiMode||'demo'),ctx)||'demo' }, ctx));
        await ai?.enqueue(store,client,batch,ctx);return batch;
      },storageMode==='postgres-tenant-databases'?ctx.tenantId:undefined);
    }
  }
  reply(res, 202, present(result)); return true;
}
function cachedOrCreate(key: string, hash: string, ctx: ImportContext, task: () => Batch) {
  const prior = importData.requests.find(r => r.key === key);
  if (prior) { if (prior.digest !== hash) throw new DomainError(409, "相同幂等键对应不同请求"); return getBatch(importData, prior.batchId, ctx); }
  const batch = task(); importData.requests.push({ key, digest: hash, batchId: batch.batchId }); return batch;
}
