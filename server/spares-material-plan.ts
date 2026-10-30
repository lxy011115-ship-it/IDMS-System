import {randomUUID} from 'node:crypto';
import {hasAccess,type AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import type {SpareEntity,SparesState,SpareReferences} from './spares.ts';

export const materialPlanActions=['material-plan.create','material-plan.edit','material-plan.close','material-plan.cancel','material-plan.reopen'] as const;
function fail(message:string,status=400):never{throw new DomainError(status,message);}
export function materialPlanPermission(ctx:AccessContext,refs:SpareReferences,orderId?:string){
 if(hasAccess(ctx,'spares:manage'))return true;
 return hasAccess(ctx,'spares:move')&&(!orderId||refs.orders.some(o=>o.id===orderId&&o.assignee===ctx.actorId));
}
const fields:Record<string,string[]>={
 'material-plan.create':['partId','warehouseId','workOrderId','quantity','needDate','reason'],
 'material-plan.edit':['id','expectedVersion','quantity','needDate','reason'],
 'material-plan.close':['id','expectedVersion','reason'],'material-plan.cancel':['id','expectedVersion','reason'],'material-plan.reopen':['id','expectedVersion','reason']
};
export function applyMaterialPlan(state:SparesState,ctx:AccessContext,refs:SpareReferences,action:string,input:Record<string,any>,quantity:(v:unknown,precision?:number)=>number){
 const allowed=fields[action];if(!allowed||Object.keys(input).some(k=>!allowed.includes(k)))fail('用料计划包含不支持的字段');
 const target=action==='material-plan.create'?undefined:state.entities.find(e=>e.tenantId===ctx.tenantId&&e.kind==='material-plan'&&e.id===input.id);
 if(action!=='material-plan.create'&&!target)fail('用料计划不存在或不在当前范围',404);
 const orderId=target?.workOrderId||input.workOrderId,order=refs.orders.find(o=>o.id===orderId);
 if(!order||!materialPlanPermission(ctx,refs,orderId))fail('当前账户不能维护此工单用料计划',403);
 if(target&&target.version!==input.expectedVersion)fail('用料计划版本已变化，请刷新后重试',409);
 const reason=typeof input.reason==='string'?input.reason.trim():'';if(!reason||reason.length>2000)fail('请填写用料计划依据');
 const part=state.entities.find(e=>e.tenantId===ctx.tenantId&&e.kind==='part'&&e.id===(target?.partId||input.partId)),warehouse=state.entities.find(e=>e.tenantId===ctx.tenantId&&e.kind==='warehouse'&&e.id===(target?.warehouseId||input.warehouseId));
 const device=refs.devices.find(d=>d.code===order.deviceCode);
 if(!part||!warehouse||!device||part.siteCode!==warehouse.siteCode||part.siteCode!==device.siteCode)fail('用料计划须关联同工厂的批准设备、备件和仓库');
 if(target&&(target.workOrderId!==order.id||target.deviceCode!==device.code||target.siteCode!==device.siteCode))fail('用料计划归属已变化，请重新核对',409);
 const now=new Date().toISOString();
 if(action==='material-plan.close'||action==='material-plan.cancel'){
  if(target!.status!=='ACTIVE')fail('仅进行中的用料计划可以关闭或取消',409);
  Object.assign(target!,{status:action==='material-plan.close'?'CLOSED':'CANCELLED',reason,closedAt:now,closedBy:ctx.actorId,version:target!.version+1});return target!;
 }
 if(!['OPEN','ASSIGNED','IN_PROGRESS','AWAITING_APPROVAL'].includes(order.state))fail('当前工单已关闭或不可登记需求',409);
 if(!hasAccess(ctx,'spares:manage')&&order.state!=='IN_PROGRESS')fail('本人维修中工单才可维护用料计划',409);
 if(part.active===false||warehouse.active===false)fail('停用备件或仓库不能用于新需求');
 if(action==='material-plan.reopen'){
  if(!['CLOSED','CANCELLED'].includes(target!.status))fail('该用料计划已经启用',409);
  Object.assign(target!,{status:'ACTIVE',reason,reopenedAt:now,reopenedBy:ctx.actorId,version:target!.version+1});return target!;
 }
 if(target&&target.status!=='ACTIVE')fail('请先人工恢复已关闭或取消的用料计划',409);
 const quantityMilli=quantity(input.quantity,part.precision);if(quantityMilli<=0)fail('计划总量必须大于零');
 const needDate=input.needDate;if(typeof needDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(needDate)||!Number.isFinite(Date.parse(needDate+'T00:00:00Z'))||new Date(needDate+'T00:00:00Z').toISOString().slice(0,10)!==needDate)fail('用料需用日期无效');
 if(target){Object.assign(target,{quantityMilli,needDate,reason,version:target.version+1});return target;}
 if(state.facts&&typeof state.facts.materialPlanConflict!=='boolean')fail('用料计划唯一性资料未核验',503);
 const conflict=state.facts?state.facts.materialPlanConflict:state.entities.some(e=>e.kind==='material-plan'&&e.workOrderId===order.id&&e.partId===part.id&&e.warehouseId===warehouse.id);
 if(conflict)fail('该工单、备件和仓库已有计划，请修订或恢复原计划',409);
 const plan:SpareEntity={id:randomUUID(),kind:'material-plan',tenantId:ctx.tenantId,siteCode:device.siteCode,deviceCode:device.code,workOrderId:order.id,partId:part.id,warehouseId:warehouse.id,quantityMilli,needDate,reason,status:'ACTIVE',version:1,createdAt:now,createdBy:ctx.actorId};
 state.entities.push(plan);return plan;
}

export function remainingMaterialDemand(plan:{status:string;quantityMilli:number},netIssuedMilli:number,orderState:string){
 if(!Number.isSafeInteger(netIssuedMilli)||netIssuedMilli<0||!Number.isSafeInteger(plan.quantityMilli)||plan.quantityMilli<=0)fail('用料计划数量无法核验',503);
 return {remainingMilli:plan.status==='ACTIVE'&&['OPEN','ASSIGNED','IN_PROGRESS','AWAITING_APPROVAL'].includes(orderState)?Math.max(0,plan.quantityMilli-netIssuedMilli):0,overPlanMilli:Math.max(0,netIssuedMilli-plan.quantityMilli),reserved:false as const};
}
