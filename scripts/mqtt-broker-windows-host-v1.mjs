import {lstat,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

const need=(value,code)=>{if(!value)throw Error(code);};
/** Windows servicing hard-links its fixed PowerShell host. This exception cannot select another program. */
export async function mqttBrokerWindowsHostV1(){
  need(process.platform==='win32','MQTT_BROKER_WINDOWS_HOST_PLATFORM');
  const path=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),before=await lstat(path);
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink>=1&&(await realpath(path)).toLowerCase()===resolve(path).toLowerCase(),'MQTT_BROKER_WINDOWS_HOST_FILE');
  const digest=createHash('sha256');for await(const bytes of createReadStream(path))digest.update(bytes);
  const after=await lstat(path);need(after.isFile()&&!after.isSymbolicLink()&&before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.nlink===after.nlink&&before.mtimeMs===after.mtimeMs,'MQTT_BROKER_WINDOWS_HOST_CHANGED');
  return {path,sha256:digest.digest('hex'),bytes:before.size,dev:String(before.dev),ino:String(before.ino),nlink:before.nlink};
}
export async function assertMqttBrokerWindowsHostV1(expected){
  const actual=await mqttBrokerWindowsHostV1();need(expected&&Object.keys(actual).every(key=>actual[key]===expected[key])&&Object.keys(actual).length===Object.keys(expected).length,'MQTT_BROKER_WINDOWS_HOST_CHANGED');
}
