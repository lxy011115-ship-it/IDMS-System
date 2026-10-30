import type pg from 'pg';
import type {AccessContext} from './access.ts';
import type {SpareEntity,SpareReferences} from './spares.ts';
import {spareQueryScope} from './spares-query-scope.ts';
import {currentQuery} from './revision-projection.ts';
import {DomainError} from './service.ts';
import {accountValue} from './capacity.ts';
import {checkSparesRead} from './spares-audit.ts';
const bad=()=>new DomainError(503,'备件当前引用资料无法核验');
/** Bounded public references for the current command, in its locked snapshot. */
export async function currentSpareReferences(c:pg.PoolClient,ctx:AccessContext,input:Record<string,unknown>,entities:SpareEntity[]):Promise<SpareReferences>{
 const devices=new Set<string>(),orders=new Set<string>();
 for(const value of [input,...entities])for(const [field,set]of [['deviceCode',devices],['workOrderId',orders]] as const){const code=value[field];if(code===undefined||code===null||code==='')continue;if(typeof code!=='string'||code.length>128||/[\u0000-\u001f\u007f]/.test(code))throw bad();set.add(code);}
 if(devices.size+orders.size>512)throw bad();accountValue([...devices,...orders]);const scope=spareQueryScope(ctx);let deviceRows:any[]=[],orderRows:any[]=[];
 if(orders.size){checkSparesRead();orderRows=(await currentQuery(c,scope.cte+"/* IDMS_SPARES_CURRENT_ORDERS */ SELECT tenant_id,id,body->>'deviceCode' AS device_code,body->>'assignee' AS assignee,body->>'state' AS state FROM spare_orders WHERE id=ANY($7::text[]) ORDER BY id LIMIT 513",[...scope.values,[...orders]])).rows;accountValue(orderRows);}
 if(orderRows.length>orders.size||new Set(orderRows.map(r=>r.id)).size!==orderRows.length||orderRows.some(r=>r.tenant_id!==ctx.tenantId||!orders.has(r.id)||typeof r.device_code!=='string'||typeof r.assignee!=='string'||typeof r.state!=='string'))throw bad();
 for(const row of orderRows)devices.add(row.device_code);if(devices.size+orders.size>512)throw bad();accountValue([...devices]);
 if(devices.size){checkSparesRead();deviceRows=(await currentQuery(c,scope.cte+'/* IDMS_SPARES_CURRENT_DEVICES */ SELECT tenant_id,device_code,device_name,site_code FROM spare_devices WHERE device_code=ANY($7::text[]) ORDER BY device_code LIMIT 513',[...scope.values,[...devices]])).rows;accountValue(deviceRows);}
 if(deviceRows.length>devices.size||new Set(deviceRows.map(r=>r.device_code)).size!==deviceRows.length||deviceRows.some(r=>r.tenant_id!==ctx.tenantId||!devices.has(r.device_code)||typeof r.device_name!=='string'||typeof r.site_code!=='string'))throw bad();
 if(orderRows.length>orders.size||new Set(orderRows.map(r=>r.id)).size!==orderRows.length||orderRows.some(r=>r.tenant_id!==ctx.tenantId||!orders.has(r.id)||typeof r.device_code!=='string'||typeof r.assignee!=='string'||typeof r.state!=='string'))throw bad();
 checkSparesRead();return {devices:deviceRows.map(r=>({code:r.device_code,name:r.device_name,siteCode:r.site_code})),orders:orderRows.map(r=>({id:r.id,deviceCode:r.device_code,assignee:r.assignee,state:r.state}))};
}
