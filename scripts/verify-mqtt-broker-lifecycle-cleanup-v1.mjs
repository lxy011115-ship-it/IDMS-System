import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

assert.equal(process.argv.length,3);const nonce=process.argv[2];assert.match(nonce,/^[a-f0-9]{12}$/);
const root=resolve('.'),work=resolve('work/mqtt-broker-lifecycle-v1-20261024',nonce),json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report=await json(join(work,'verification.json'));assert.equal(report.nonce,nonce);assert(report.cleanupComplete);const reuse=[];
for(const pin of report.sourcePins)assert.equal(hash(await readFile(pin.path)),pin.sha256);
for(const item of report.outcomes){
  const rel=relative(work,item.directory);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
  const launch=await json(join(item.directory,'launch-intent.private.json')),exit=await json(join(item.directory,'exit-observation.json'));assert.equal(exit.owner,launch.owner);assert.equal(exit.pid,item.pid);assert.equal(exit.code,item.exit.code);assert.equal(exit.signal,null);assert(exit.stdoutClosed&&exit.stderrClosed);
  for(const pin of launch.pins)assert.equal(hash(await readFile(pin.path)),pin.sha256);
  if(item.normalClose){
    const stop=await json(join(item.directory,'stop-intent.json')),control=await json(join(item.directory,'stop-control.private.json')),proof=await json(join(item.directory,'normal-stop-proof.json'));assert.deepEqual(proof,item.proof);assert.equal(stop.owner,launch.owner);assert.equal(stop.requestId,proof.requestId);assert.equal(control.owner,launch.owner);assert.equal(control.requestId,proof.requestId);assert(control.delivered);assert.equal(exit.code,0);assert(proof.normalClose&&proof.controlDelivered&&!proof.genericKillUsed&&proof.helperAttempts===1);assert.equal(proof.businessMessageDrainProven,false);
    if(process.platform==='win32'){assert(control.completed&&control.nativeExitCode===0);assert.equal(control.createdFileTime,proof.identity.createdFileTime);assert(control.ownListener&&control.eventAvailable&&control.commandLineBound);assert.equal(control.parentPid,launch.parentPid);assert.equal(control.challengeSha256,hash(launch.challenge));assert.equal(control.helperExit.code,0);}
  }else assert.equal(exit.code,1);
  if(process.platform==='linux')try{const command=(await readFile('/proc/'+item.pid+'/cmdline','utf8')).replaceAll('\0',' ');assert(!command.includes(join(item.directory,'mosquitto.conf')));reuse.push({pid:item.pid,originalConfigurationAbsent:true});}catch(error){if(error.code!=='ENOENT')throw error;}
  else{
    const script="$idmsAuditedBroker=Get-CimInstance Win32_Process -Filter 'ProcessId = "+item.pid+"';if($idmsAuditedBroker){[pscustomobject]@{command=$idmsAuditedBroker.CommandLine}|ConvertTo-Json -Compress}";
    const output=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,maxBuffer:1024**2});
    if(output.stdout.trim()){const current=JSON.parse(output.stdout);assert(!current.command.replaceAll('\\','/').includes(join(item.directory,'mosquitto.conf').replaceAll('\\','/')));reuse.push({pid:item.pid,originalConfigurationAbsent:true});}
  }
}
if(report.passed){assert.equal(report.checks.length,9);assert.equal(report.outcomes.length,5);assert.equal(report.outcomes.filter(item=>item.normalClose).length,4);assert(report.actualQos1BusinessRoundTrip&&report.healthCannotPublishBusiness);if(process.platform==='win32')assert(report.wrongCreationTimeRejectedWithoutDelivery);}
const result={format:'IDMS_MQTT_BROKER_INDEPENDENT_CLEANUP_V1',at:new Date().toISOString(),nonce,nativePassed:report.passed,nativeChecks:report.checks.length,ownedRootsRetired:report.outcomes.length,normalOwnedStops:report.outcomes.filter(item=>item.normalClose).length,expectedStartupFailures:report.outcomes.filter(item=>!item.normalClose).length,sourcePinsVerified:report.sourcePins.length,allOwnedRootsTerminal:true,actualQos1RoundTrip:report.actualQos1BusinessRoundTrip===true,healthBusinessWritesDenied:report.healthCannotPublishBusiness===true,businessMessageDrainProven:false,reusedPids:reuse,signalsSent:false,originalDatabaseContacted:false,fullGoalComplete:false};
await import('node:fs/promises').then(fs=>fs.writeFile(join(work,'independent-cleanup.json'),JSON.stringify(result,null,2),{flag:'wx'}));console.log(JSON.stringify(result));
