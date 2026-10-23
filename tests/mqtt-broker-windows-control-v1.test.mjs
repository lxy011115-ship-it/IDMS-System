import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {privateDirectory,privateNewFile} from '../scripts/backup-support.mjs';
import {mqttBrokerHashV1 as hash} from '../scripts/mqtt-broker-runtime-v1.mjs';

test('Windows control compiles and refuses an actual owned non-broker without signalling it',{skip:process.platform!=='win32'},async()=>{
  const owner=randomUUID(),parent=resolve('work/mqtt-broker-control-contract-v1'),directory=join(parent,'mqtt-broker-process-'+owner);await privateDirectory(directory);
  const configFile=join(directory,'mosquitto.conf'),bytes=Buffer.from('listener 29999 127.0.0.1\n');await privateNewFile(configFile,bytes);
  const child=spawn(process.execPath,['-e','process.stdin.resume()'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const terminal=new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok({code,signal}));});terminal.catch(()=>{});
  let created=null;const observations=[];
  try{
    for(const action of ['INSPECT','SHUTDOWN']){
      const requestFile=join(directory,'control-'+randomUUID()+'.request.private.json'),resultFile=requestFile.replace('.request.private.json','.result.private.json'),challenge=randomBytes(32).toString('hex');
      const value={format:'IDMS_MQTT_BROKER_WIN_CONTROL_V1',action,owner,challenge,parentPid:process.pid,pid:child.pid,expectedCreatedFileTime:created,program:join(process.env.LOCALAPPDATA,'IDMS/runtime/mosquitto-2.1.2/mosquitto.exe'),configFile,configSha256:hash(bytes),port:29999,resultFile};
      await privateNewFile(requestFile,JSON.stringify(value));
      const helper=spawn(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../scripts/mqtt-broker-windows-control-v1.ps1',import.meta.url)),requestFile],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stderr='';helper.stdout.resume();helper.stderr.on('data',part=>stderr+=part);
      const exit=await new Promise((ok,no)=>{helper.once('error',no);helper.once('close',(code,signal)=>ok({code,signal}));});
      let result;try{result=JSON.parse(await readFile(resultFile,'utf8'));}catch{throw Error('MQTT_BROKER_CONTROL_TEST_NO_RESULT:'+stderr.slice(-1200));}
      assert.equal(exit.code,1);assert.equal(exit.signal,null);assert.equal(result.errorCode,'MQTT_BROKER_WIN_CONTROL_REJECTED');
      assert.equal(result.helperPid,helper.pid);assert.equal(result.owner,owner);assert.equal(result.challengeSha256,hash(challenge));assert.equal(result.pid,child.pid);
      assert.equal(result.delivered,false);assert.equal(result.completed,false);assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
      assert.match(result.createdFileTime,/^[0-9]{16,21}$/);created=result.createdFileTime;
      observations.push({action,rejectedWrongActualExecutable:true,delivered:false,actualHelperExitCode:1});
    }
  }finally{child.stdin.end();assert.deepEqual(await terminal,{code:0,signal:null});}
  await privateNewFile(join(directory,'verification.json'),JSON.stringify({owner,observations,actualOwnedNodeRootNormallyClosed:true,brokerCreated:false,sourceConfigTouched:false}));
});
