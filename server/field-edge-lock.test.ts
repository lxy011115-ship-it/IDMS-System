import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {FieldEdgeLock} from '../services/field/edge-lock.ts';
test('本机真实IPC按企业/边缘身份互斥，设备/点表路径变化不能绕过，关闭终态后可重新取得',async()=>{const source={tenantId:'lockqa',edgeId:randomUUID(),deviceCode:'DEVICE-A',mapVersion:'1'},a=new FieldEdgeLock(source),b=new FieldEdgeLock({...source,deviceCode:'DEVICE-B',mapVersion:'2'});try{await a.acquire();assert.equal(a.held,true);await assert.rejects(b.acquire(),{code:'FIELD_EDGE_ALREADY_RUNNING'});assert.equal(a.held,true);await b.close();await a.close();const c=new FieldEdgeLock(source);try{await c.acquire();assert.equal(c.held,true);}finally{await c.close();}}finally{await a.close();await b.close();}});
test('不同本机边缘身份可分别持锁，停用锁不可再次取得',async()=>{const source={tenantId:'lockqa',edgeId:randomUUID(),deviceCode:'DEVICE-A',mapVersion:'1'},a=new FieldEdgeLock(source),b=new FieldEdgeLock({...source,edgeId:randomUUID()});try{await a.acquire();await b.acquire();assert.equal(a.held&&b.held,true);await a.close();await assert.rejects(a.acquire(),{code:'FIELD_EDGE_LOCK_BUSY'});}finally{await a.close();await b.close();}});
