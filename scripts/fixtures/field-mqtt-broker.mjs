import {createServer,createConnection} from 'node:net';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {brokerRoot} from '../mqtt-local.mjs';
// Owned loopback QA broker only; this is not a production provisioning command.
export async function createFieldMqttBroker(fixture){
 const reservation=createServer();await new Promise(ok=>reservation.listen(0,'127.0.0.1',ok));const port=reservation.address().port;await new Promise(ok=>reservation.close(ok));const url='mqtts://127.0.0.1:'+port,t=fixture.declaration(url),native=p=>p.replaceAll('\\','/'),acl=resolve(fixture.directory,'workspace-acl'),conf=resolve(fixture.directory,'workspace-broker.conf');
 await writeFile(acl,`user ${t.edgeClientId}\ntopic write ${t.topics.telemetry}\ntopic read ${t.topics.ack}\nuser ${t.platformClientId}\ntopic read ${t.topics.telemetry}\ntopic write ${t.topics.ack}\n`);await writeFile(conf,`listener ${port} 127.0.0.1\nallow_anonymous false\nrequire_certificate true\nuse_identity_as_username true\nuse_username_as_clientid true\ncafile ${native(resolve(fixture.directory,'ca.pem'))}\ncertfile ${native(resolve(fixture.directory,'broker.pem'))}\nkeyfile ${native(resolve(fixture.directory,'broker.key'))}\nacl_file ${native(acl)}\nmax_qos 1\nretain_available false\nmax_packet_size 32768\nmax_queued_messages 20\nmax_inflight_messages 1\npersistence false\nlog_type error\n`);
 const child=spawn(resolve(brokerRoot,'mosquitto.exe'),['-c',conf],{stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',spawnError;for(const p of [child.stdout,child.stderr])p.on('data',b=>output=(output+b).slice(-2000));child.on('error',e=>spawnError=e);const close=async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}};
 try{const deadline=Date.now()+5000;while(Date.now()<deadline){if(spawnError||child.exitCode!==null||child.signalCode!==null)throw Error('Owned field broker unavailable: '+output);const ready=await new Promise(ok=>{const c=createConnection({host:'127.0.0.1',port});c.once('connect',()=>{c.destroy();ok(true);});c.once('error',()=>ok(false));});if(ready)return {url,child,close};await new Promise(ok=>setTimeout(ok,20));}throw Error('Owned field broker listener not confirmed');}catch(e){await close();throw e;}
}
