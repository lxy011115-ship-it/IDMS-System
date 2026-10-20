import test from 'node:test';
import assert from 'node:assert/strict';
import {requireAuthAuditTransportV4} from './auth-audit-transport-v4.ts';
test('runtime accounts are explicit and reject remote plaintext or certificate bypass before a client can be created',()=>{
 const local={host:'127.0.0.1',port:5432,user:'app',password:'private',database:'audit'};assert.doesNotThrow(()=>requireAuthAuditTransportV4(local));assert.doesNotThrow(()=>requireAuthAuditTransportV4({...local,host:'db.example.invalid',ssl:{rejectUnauthorized:true}}));
 for(const override of [{host:'db.example.invalid'},{host:'db.example.invalid',ssl:{rejectUnauthorized:false}},{connectionString:'postgres://hidden'},{host:undefined},{port:undefined},{database:undefined}])assert.throws(()=>requireAuthAuditTransportV4({...local,...override}));
});
