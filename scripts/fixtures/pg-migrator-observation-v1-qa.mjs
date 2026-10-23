import pg from 'pg';
import {summarizeControlledColdFailureQaV2} from './controlled-cold-stage-diagnostic-v2-qa.mjs';

const driverConditions=new Map([
  ['Client has encountered a connection error and is not queryable','CLIENT_CONNECTION_UNUSABLE'],
  ['Client was closed and is not queryable','CLIENT_ALREADY_CLOSED'],
  ['Connection terminated unexpectedly','CONNECTION_ENDED_UNEXPECTEDLY'],
  ['Connection terminated','CONNECTION_ENDED'],
  ['Query read timeout','CLIENT_QUERY_READ_TIMEOUT'],
  ['timeout expired','CLIENT_CONNECTION_TIMEOUT']
]);
const operation=value=>{
  if(typeof value!=='string')return 'NON_STRING';
  const word=/^\s*(BEGIN|COMMIT|ROLLBACK|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT|REVOKE|SET)\b/i.exec(value.slice(0,64));
  return word?word[1].toUpperCase():'OTHER';
};
let installed=false;

/** QA only. Keep the native Promise, exact arguments and thrown object intact. */
export function installPgMigratorObservationQaV1({emit=value=>console.log(JSON.stringify(value))}={}){
  if(installed||typeof emit!=='function')throw Error('PG_MIGRATOR_OBSERVER_INPUT');
  const prototype=pg.Client.prototype,nativeQuery=prototype.query,nativeConnect=prototype.connect;
  if(typeof nativeQuery!=='function'||typeof nativeConnect!=='function')throw Error('PG_MIGRATOR_OBSERVER_NATIVE_METHOD');
  installed=true;let active=true,total=0,emitted=0,emissionFailures=0,nextClient=0;
  const clients=new WeakMap();
  const selected=client=>active&&typeof client?.connectionParameters?.user==='string'&&client.connectionParameters.user.endsWith('_migrator');
  function identity(client){let value=clients.get(client);if(!value){value={ordinal:++nextClient,queries:0};clients.set(client,value);}return value;}
  function record(error,phase,kind,client,ordinal){
    if(!active)return;total++;if(emitted>=64)return;emitted++;
    try{
      const summary=summarizeControlledColdFailureQaV2(error);
      const value={format:'IDMS_PG_MIGRATOR_ERROR_OBSERVATION_V1',sequence:emitted,phase,operation:kind,clientOrdinal:identity(client).ordinal,queryOrdinal:ordinal,errorKind:summary.errorKind,errorCode:summary.errorCode,sqlState:summary.sqlState,causeSqlState:summary.causeSqlState,messageSha256:summary.messageSha256,driverCondition:driverConditions.get(error?.message)??null,sqlOrParametersPrinted:false,credentialsPrinted:false,originalErrorPreserved:true};
      emit(value);
    }catch{emissionFailures++;}
  }
  function observe(value,phase,kind,client,ordinal){
    // Attaching a rejection observer never replaces the native return value.
    // The observer handles its own failure and its child Promise cannot reject.
    if(value&&typeof value.then==='function')void value.then(undefined,error=>{record(error,phase,kind,client,ordinal);});
    return value;
  }
  function query(...args){
    const track=selected(this)&&!args.some(value=>typeof value==='function'),ordinal=track?++identity(this).queries:0;
    try{const value=Reflect.apply(nativeQuery,this,args);return track?observe(value,'QUERY',operation(args[0]),this,ordinal):value;}
    catch(error){if(track)record(error,'QUERY',operation(args[0]),this,ordinal);throw error;}
  }
  function connect(...args){
    const track=selected(this)&&!args.some(value=>typeof value==='function');
    try{const value=Reflect.apply(nativeConnect,this,args);return track?observe(value,'CONNECT','CONNECT',this,0):value;}
    catch(error){if(track)record(error,'CONNECT','CONNECT',this,0);throw error;}
  }
  prototype.query=query;prototype.connect=connect;
  return Object.freeze({
    state(){return {active,totalErrorsObserved:total,eventsEmitted:emitted,eventsSuppressed:Math.max(0,total-emitted),emissionFailures,clientsObserved:nextClient};},
    restore(){
      if(!active)return;
      if(prototype.query!==query||prototype.connect!==connect)throw Error('PG_MIGRATOR_OBSERVER_RESTORE_CONFLICT');
      prototype.query=nativeQuery;prototype.connect=nativeConnect;active=false;installed=false;
    }
  });
}
