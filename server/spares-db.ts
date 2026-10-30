import type pg from 'pg';
import {canonical,digest} from './imports.ts';
import {DomainError} from './service.ts';
import {sparesView,spareCommand,authorizeSpare,spareVisible,type SparesState,type SpareEntity,type SpareReferences} from './spares.ts';
import type {AccessContext} from './access.ts';
import {prepareSpareCommand,validateSpareRow,type SpareReferenceResolver} from './spares-workset.ts';
import {verifySpareAudit,checkSparesRead} from './spares-audit.ts';
import {streamRows} from './pg-row-stream.ts';
import {spareTransaction} from './spares-transaction.ts';
import {currentSpareReferences} from './spares-current-refs.ts';
import {accountValue} from './capacity.ts';
import {spareEventHash} from './spares-audit-chain.ts';
export const sparesSchema=`
CREATE SCHEMA idms_spares;
CREATE TABLE idms_spares.state(tenant_id text PRIMARY KEY,revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0));
CREATE TABLE idms_spares.entities(tenant_id text NOT NULL,id uuid NOT NULL,kind text NOT NULL,site_code text NOT NULL,body jsonb NOT NULL,CHECK(body->>'id'=id::text AND body->>'tenantId'=tenant_id AND body->>'kind'=kind AND body->>'siteCode'=site_code),PRIMARY KEY(tenant_id,kind,id)) PARTITION BY LIST(kind);
${['warehouse','supplier','part','purchase','receipt','movement','link','replacement','adjustment','document'].map(k=>`CREATE TABLE idms_spares.${k}_records PARTITION OF idms_spares.entities FOR VALUES IN ('${k}');`).join('\n')}
CREATE INDEX spares_kind ON idms_spares.entities(tenant_id,kind,site_code);
CREATE TABLE idms_spares.events(tenant_id text NOT NULL,sequence bigint NOT NULL,site_code text NOT NULL,body jsonb NOT NULL,hash text NOT NULL,PRIMARY KEY(tenant_id,sequence));
CREATE TABLE idms_spares.receipts(tenant_id text NOT NULL,request_key text NOT NULL,request_hash text NOT NULL,response jsonb NOT NULL,PRIMARY KEY(tenant_id,request_key));`;
export const sparesHistorySchema=`CREATE OR REPLACE FUNCTION idms_spares.guard_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' OR OLD.kind IN ('movement','receipt','replacement','document') OR OLD.site_code<>NEW.site_code OR OLD.tenant_id<>NEW.tenant_id OR (OLD.kind='material-plan' AND (OLD.body->>'partId',OLD.body->>'warehouseId',OLD.body->>'workOrderId',OLD.body->>'deviceCode') IS DISTINCT FROM (NEW.body->>'partId',NEW.body->>'warehouseId',NEW.body->>'workOrderId',NEW.body->>'deviceCode')) THEN RAISE EXCEPTION 'Posted spares history or plan identity is immutable'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS spares_history_guard ON idms_spares.entities;
CREATE TRIGGER spares_history_guard BEFORE UPDATE OR DELETE ON idms_spares.entities FOR EACH ROW EXECUTE FUNCTION idms_spares.guard_history();
REVOKE ALL ON FUNCTION idms_spares.guard_history() FROM PUBLIC;`;
async function available(c:pg.PoolClient){return !!(await c.query("SELECT to_regclass('idms_spares.state') AS relation")).rows[0]?.relation;}
async function load(c:pg.PoolClient,tenant:string):Promise<SparesState>{
 const rows=(await c.query('SELECT body FROM idms_spares.entities WHERE tenant_id=$1 ORDER BY id LIMIT 10001',[tenant])).rows;if(rows.length>10000)throw new DomainError(413,'备件资料超过当前本地模块容量，请先归档或升级查询');
 const entities=rows.map(r=>r.body as SpareEntity);if(entities.some(e=>e.tenantId!==tenant))throw new DomainError(503,'备件企业边界校验失败');if(entities.some(e=>e.kind==='material-plan'))throw new DomainError(409,'此数据库已有工单用料计划，请使用当前分页和洞察接口');return {entities};
}
export async function verifySparesDatabase(c:pg.PoolClient,tenant:string){
 if(!await available(c))return;
 for(const table of ['state','entities','events','receipts'])if((await c.query(`SELECT 1 FROM idms_spares.${table} WHERE tenant_id IS DISTINCT FROM $1 LIMIT 1`,[tenant])).rowCount)throw new DomainError(503,'备件备份含其他企业数据');
 const revision=(await c.query('SELECT revision::text FROM idms_spares.state WHERE tenant_id=$1',[tenant])).rows[0];if(!revision)throw new DomainError(503,'备件企业状态缺失');await verifySpareAudit(c,tenant,revision.revision);
 await streamRows(c,'/* IDMS_SPARES_BACKUP_ENTITY_STREAM */ SELECT tenant_id,id::text,kind,site_code,body FROM idms_spares.entities WHERE tenant_id=$1 ORDER BY id,kind',row=>{checkSparesRead();validateSpareRow(row,tenant);},()=>{},[tenant]);
}
export async function readSpares(pool:pg.Pool,ctx:AccessContext,refs:SpareReferences){const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');if(!await available(c)){await c.query('COMMIT');return {available:false,notice:'备件采购模块待初始化，请由本地部署人员执行专用迁移。'};}const revision=(await c.query('SELECT revision::text FROM idms_spares.state WHERE tenant_id=$1',[ctx.tenantId])).rows[0]?.revision;if(revision===undefined)throw new DomainError(503,'备件企业状态缺失');await verifySpareAudit(c,ctx.tenantId,revision);const state=await load(c,ctx.tenantId),result=sparesView(state,ctx,refs);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
async function executeSpareCommand(c:pg.PoolClient,ctx:AccessContext,source:SpareReferences|SpareReferenceResolver,action:string,input:Record<string,any>,requestKey:string){
 if(!await available(c))throw new DomainError(503,'备件采购模块待初始化');const locked=(await c.query('SELECT revision::text FROM idms_spares.state WHERE tenant_id=$1 FOR UPDATE',[ctx.tenantId])).rows[0];if(!locked)throw new DomainError(503,'备件企业状态缺失');const {state,refs,eventWireVersion}=await prepareSpareCommand(c,ctx,source,action,input);accountValue({state,refs});authorizeSpare(state,action,input,ctx,refs);
 const key=ctx.actorId+':'+requestKey,hash=digest(canonical({action,input})),head=await verifySpareAudit(c,ctx.tenantId,locked.revision),prior=(await c.query('SELECT request_hash,response FROM idms_spares.receipts WHERE tenant_id=$1 AND request_key=$2',[ctx.tenantId,key])).rows[0];if(prior){if(prior.request_hash!==hash)throw new DomainError(409,'同一幂等键的请求内容不同');if(!prior.response||!spareVisible(prior.response,ctx,refs))throw new DomainError(403,'原回执不在当前授权范围');return prior.response;}
 const before=new Map(state.entities.map(e=>[e.id,canonical(e)])),beforeRows=new Map(state.entities.map(e=>[e.id,structuredClone(e)]));accountValue({before,beforeRows});const result=spareCommand(state,action,input,ctx,refs),changed=state.entities.filter(e=>before.get(e.id)!==canonical(e));
 for(const e of changed){const written=await c.query('INSERT INTO idms_spares.entities(tenant_id,id,kind,site_code,body) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,kind,id) DO UPDATE SET body=EXCLUDED.body WHERE idms_spares.entities.site_code=EXCLUDED.site_code',[ctx.tenantId,e.id,e.kind,e.siteCode,JSON.stringify(e)]);if(written.rowCount!==1)throw new DomainError(409,'备件实体工厂归属冲突');}
 const event=JSON.parse(JSON.stringify({...(eventWireVersion===2?{wireVersion:2}:{}),tenantId:ctx.tenantId,actor:ctx.actorId,action,at:new Date().toISOString(),correlationId:ctx.correlationId,requestHash:hash,previousHash:head.previous,before:changed.map(e=>beforeRows.get(e.id)||null),after:changed}));accountValue(event);checkSparesRead();await c.query('INSERT INTO idms_spares.events(tenant_id,sequence,site_code,body,hash) VALUES($1,$2,$3,$4::jsonb,$5)',[ctx.tenantId,(head.sequence+1n).toString(),result!.siteCode,JSON.stringify(event),spareEventHash(event)]);await c.query('INSERT INTO idms_spares.receipts VALUES($1,$2,$3,$4::jsonb)',[ctx.tenantId,key,hash,JSON.stringify(result)]);const updated=await c.query('UPDATE idms_spares.state SET revision=revision+1 WHERE tenant_id=$1',[ctx.tenantId]);if(updated.rowCount!==1)throw new DomainError(503,'备件模块企业状态未初始化');return result;
}
const commandKey=(key:string)=>{if(!/^[A-Za-z0-9._:-]{8,160}$/.test(key))throw new DomainError(400,'备件写入需要有效的幂等键');};
/** Explicit pre-derived reference adapter for isolated/domain comparison callers. */
export async function commandSpares(pool:pg.Pool,ctx:AccessContext,refs:SpareReferences,action:string,input:Record<string,any>,requestKey:string){commandKey(requestKey);return spareTransaction(pool,ctx,{write:true},c=>executeSpareCommand(c,ctx,refs,action,input,requestKey));}
/** HTTP writes lock original business before inventory and re-read references on
 * every fully rolled-back retry. No second connection/workspace is acquired. */
export async function commandSparesCurrent(pool:pg.Pool,ctx:AccessContext,action:string,input:Record<string,any>,requestKey:string,verify:(c:pg.PoolClient)=>Promise<void>){
 commandKey(requestKey);return spareTransaction(pool,ctx,{write:true,lockPublic:true,verify},c=>executeSpareCommand(c,ctx,entities=>currentSpareReferences(c,ctx,input,entities),action,input,requestKey));
}
