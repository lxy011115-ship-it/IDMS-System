import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,digest} from './imports.ts';
import {canonicalDigest,canonicalEqual,jsonWireClone} from './canonical-state.ts';

const corpus:any[]=[null,true,false,0,-0,NaN,Infinity,-Infinity,1e-20,1e21,'','"\\\n\u0000汉字😀','\ud800','\udfff',[],[undefined,,null],[1,2],{}, {b:undefined,a:1},new Date('2020-01-01Z'),new Number(4),{x:()=>true},'x'.repeat(8191)+'😀'.repeat(30000)+'\ud800'+ '\\'.repeat(100000)];
test('streaming SHA256 preserves every old canonical byte including Unicode chunk boundaries',()=>{
 for(const value of corpus)assert.equal(canonicalDigest(value),digest(canonical(value)));
 let state=4021;const next=()=>state=(Math.imul(state,1664525)+1013904223)>>>0;
 function value(depth:number):any{const n=next()%7;if(!depth||n<3)return [null,next()/0xffffffff,String(next())+'汉😀\n'][n%3];if(n%2)return Array.from({length:next()%8},()=>value(depth-1));return Object.fromEntries(Array.from({length:next()%8},(_,i)=>['k'+(7-i),value(depth-1)]));}
 for(let i=0;i<250;i++){const item=value(4);assert.equal(canonicalDigest(item),digest(canonical(item)));}
});
test('bounded equality matches canonical equality on JSON and historical undefined values',()=>{
 for(const a of corpus)for(const b of corpus)assert.equal(canonicalEqual(a,b),canonical(a)===canonical(b));
 const a={file:'x'.repeat(8*1024*1024),rows:[{x:1}]},b=structuredClone(a);assert.ok(canonicalEqual(a,b));b.rows[0].x=2;assert.equal(canonicalEqual(a,b),false);
 assert.equal(canonicalEqual({},undefined),false);assert.equal(canonicalEqual({b:1,a:2},Object.assign(()=>{}, {toJSON:()=>({a:2,b:1})})),true);
});
test('wire normalization preserves JSON values, undefined, arrays, toJSON and safe prototype keys',()=>{
 const values=[...corpus,{date:new Date('2020-01-01Z'),missing:undefined,nan:NaN,boxed:[new Boolean(false),new String('text')],custom:{toJSON:(key:string)=>({key})}},JSON.parse('{"__proto__":{"polluted":true},"constructor":"ordinary"}')];
 for(const v of values)assert.deepEqual(jsonWireClone(v),JSON.parse(JSON.stringify(v)));
 const shared={x:1},clone=jsonWireClone({a:shared,b:shared});assert.notEqual(clone.a,clone.b);assert.equal(Object.getPrototypeOf(clone),Object.prototype);assert.equal(({} as any).polluted,undefined);
 const cycle:any={};cycle.self=cycle;assert.throws(()=>jsonWireClone(cycle));assert.throws(()=>canonicalDigest(cycle));for(const invalid of [undefined,1n,Object(1n)])assert.throws(()=>jsonWireClone(invalid));assert.throws(()=>canonicalDigest(1n));
});
