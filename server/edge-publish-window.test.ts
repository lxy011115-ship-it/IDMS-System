import test from 'node:test';
import assert from 'node:assert/strict';
import {EdgePublishWindow} from '../services/edge/publish-window.ts';
test('business ACK window stays occupied after broker publication and only matching completion releases it',()=>{
 const w=new EdgePublishWindow();assert(w.begin('original',0));assert.equal(w.begin('next',100),false);assert.equal(w.complete('foreign'),false);assert(w.blocked(1000));assert(w.complete('original'));assert(w.begin('next',1001));
});
test('expired business ACK keeps the original retry possible within one bounded slot',()=>{
 const w=new EdgePublishWindow(1000);w.begin('original',0);assert(w.blocked(999));assert.equal(w.blocked(1000),false);assert(w.begin('original',1000));assert.equal(w.begin('second',1001),false);assert.throws(()=>new EdgePublishWindow(0));assert.throws(()=>new EdgePublishWindow(300001));
});
