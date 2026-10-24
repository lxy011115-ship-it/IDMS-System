import type {KeyObject} from 'node:crypto';
import {domainMapAssert as need} from './domain-map-v4.ts';
import type {FieldMapSnapshotV1} from './field-map-audit-v1.ts';
import {assertFieldMapIntakePreparedV1} from './field-map-intake-bootstrap-v1.ts';
import {fieldMapDeviceKeyV1,fieldMapOrderKeyV1,fieldMapReceiptKeyV1,inspectFieldMapReceiptV1,fieldMapPointKeyV1,type FieldMapStorageV1} from './field-map-receive-v1.ts';
/** A single trusted snapshot gives stable reverse pages; the HTTP host must authorize the device scope. */
export async function readFieldMapPointPageV1(s:FieldMapSnapshotV1,deviceCode:string,storage:FieldMapStorageV1,keys:ReadonlyMap<string,KeyObject>,{limit=8,beforePosition}:{limit?:number;beforePosition?:string}={}){
 need(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deviceCode)&&Number.isInteger(limit)&&limit>=1&&limit<=16,'FIELD_MAP_POINT_QUERY');await assertFieldMapIntakePreparedV1(s);
 const state=await s.state('field_point_head',fieldMapDeviceKeyV1(deviceCode));if(!state.present){need(beforePosition===undefined,'FIELD_MAP_POINT_CURSOR');return {head:s.head,deviceCode,total:'0',items:[],nextBeforePosition:null};}
 const h=state.value as {tenantId:string;deviceCode:string;count:string};need(h.tenantId===s.tenantId&&h.deviceCode===deviceCode&&/^[1-9][0-9]{0,18}$/.test(h.count)&&BigInt(h.count)<=9223372036854775807n,'FIELD_MAP_POINT_INDEX');
 const ceiling=BigInt(h.count)+1n;if(beforePosition!==undefined)need(/^[1-9][0-9]{0,18}$/.test(beforePosition)&&BigInt(beforePosition)<=ceiling,'FIELD_MAP_POINT_CURSOR');let position=beforePosition===undefined?ceiling:BigInt(beforePosition);const items=[];
 while(position>1n&&items.length<limit){position--;const order=await s.get<any>('field_point_order',fieldMapOrderKeyV1(deviceCode,String(position)));need(order.tenantId===s.tenantId&&order.deviceCode===deviceCode&&order.position===String(position)&&typeof order.receiptKey==='string','FIELD_MAP_POINT_INDEX');const raw=await s.get<any>('receipt',order.receiptKey),key=keys.get(raw.envelope?.lease?.body?.keyId);need(key,'FIELD_MAP_HISTORICAL_KEY_REQUIRED');const checked=await inspectFieldMapReceiptV1(s,raw,key,storage);need(checked.receipt.status==='STORED'&&checked.event.source.deviceCode===deviceCode&&order.eventId===checked.event.eventId&&order.receiptKey===fieldMapReceiptKeyV1(checked.event),'FIELD_MAP_POINT_INDEX');items.push({position:String(position),point:await s.get('blob',fieldMapPointKeyV1(checked.event.eventId)),receipt:checked.receipt});}
 return {head:s.head,deviceCode,total:h.count,items,nextBeforePosition:position>1n?String(position):null};
}
