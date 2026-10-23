import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import pg from 'pg';
import {installPgMigratorObservationQaV1} from '../scripts/fixtures/pg-migrator-observation-v1-qa.mjs';

test('query observation preserves the exact native Promise, arguments and first error before a later rollback error',async()=>{
  const prototype=pg.Client.prototype,native=prototype.query,events=[],secret=randomBytes(32).toString('hex'),first=Object.assign(Error(secret),{code:'23505',severity:'ERROR',detail:secret}),rollback=Error('Client has encountered a connection error and is not queryable');
  const client=new pg.Client({user:'qa_migrator',password:secret}),promises=[],calls=[];let observer;
  prototype.query=function(...args){assert.equal(this,client);calls.push(args);let reject;const promise=new Promise((_,no)=>reject=no);promises.push({promise,reject});return promise;};
  try{
    observer=installPgMigratorObservationQaV1({emit:value=>events.push(value)});
    const params=[secret],result=client.query('INSERT '+secret,params);assert.equal(result,promises[0].promise);assert.equal(calls[0][1],params);
    promises[0].reject(first);await assert.rejects(result,error=>error===first);
    const second=client.query('ROLLBACK');assert.equal(second,promises[1].promise);promises[1].reject(rollback);await assert.rejects(second,error=>error===rollback);
    assert.equal(events.length,2);assert.equal(events[0].sqlState,'23505');assert.equal(events[0].operation,'INSERT');assert.equal(events[1].operation,'ROLLBACK');assert.equal(events[1].driverCondition,'CLIENT_CONNECTION_UNUSABLE');assert.equal(events[1].queryOrdinal,2);assert.equal(events[0].clientOrdinal,events[1].clientOrdinal);assert(!JSON.stringify(events).includes(secret));assert.equal(first.detail,secret);
  }finally{observer?.restore();prototype.query=native;}
});

test('unrelated clients and callback/query-object APIs pass through without rewriting arguments or observing them',async()=>{
  const prototype=pg.Client.prototype,native=prototype.query,events=[],calls=[],token={},callback=()=>{},queryObject={submit(){}};let observer;
  prototype.query=function(...args){calls.push({client:this,args});return token;};
  try{
    observer=installPgMigratorObservationQaV1({emit:value=>events.push(value)});
    const app=new pg.Client({user:'qa_app'}),migrator=new pg.Client({user:'qa_migrator'});
    assert.equal(app.query('SELECT 1'),token);assert.equal(migrator.query(queryObject,callback),token);assert.equal(calls[1].args[0],queryObject);assert.equal(calls[1].args[1],callback);assert.deepEqual(events,[]);
  }finally{observer?.restore();prototype.query=native;}
});

test('bounded logging and a failing emitter never replace a native synchronous failure',()=>{
  const prototype=pg.Client.prototype,native=prototype.query,error=Object.assign(Error(randomBytes(30).toString('hex')),{code:'42501',severity:'ERROR'});let observer,emissions=0;
  prototype.query=function(){throw error;};
  try{
    observer=installPgMigratorObservationQaV1({emit:()=>{emissions++;throw Error('synthetic emitter failure');}});
    const client=new pg.Client({user:'qa_migrator'});for(let i=0;i<70;i++)assert.throws(()=>client.query('SELECT 1'),value=>value===error);
    assert.equal(emissions,64);assert.deepEqual(observer.state(),{active:true,totalErrorsObserved:70,eventsEmitted:64,eventsSuppressed:6,emissionFailures:64,clientsObserved:1});
    assert.throws(()=>installPgMigratorObservationQaV1(),/PG_MIGRATOR_OBSERVER_INPUT/);
  }finally{observer?.restore();prototype.query=native;}
});

test('actual pg connection rejection to an owned closing TCP server is observed and the connection reaches terminal close',async t=>{
  const events=[],sockets=new Set(),server=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.destroy();});
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
  const client=new pg.Client({host:'127.0.0.1',port:server.address().port,user:'qa_migrator',database:'qa',password:randomBytes(32).toString('hex'),connectionTimeoutMillis:2000});let observer;
  try{
    observer=installPgMigratorObservationQaV1({emit:value=>events.push(value)});let original;
    await assert.rejects(client.connect().catch(error=>{original=error;throw error;}),error=>error===original);
    await client.end();assert.equal(events.length,1);assert.equal(events[0].phase,'CONNECT');
    assert(['ECONNRESET','EPIPE'].includes(events[0].errorCode)||['CONNECTION_ENDED_UNEXPECTEDLY','CONNECTION_ENDED'].includes(events[0].driverCondition),JSON.stringify(events));
    assert.equal(events[0].sqlState,null);t.diagnostic(JSON.stringify({actualConnectionErrorCode:events[0].errorCode,actualDriverCondition:events[0].driverCondition,rawCredentialsPrinted:false}));
  }finally{observer?.restore();for(const socket of sockets)socket.destroy();await new Promise((ok,no)=>server.close(error=>error?no(error):ok()));}
  assert.equal(server.listening,false);
});
