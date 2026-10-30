import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export function demoEnvironment(parent,{port=4010,namespace='packaged-demo'}={}){
 if(!Number.isInteger(port)||port<1||port>65535||!/^[A-Za-z0-9_-]{1,80}$/.test(namespace))throw Error('Invalid local demo port or namespace');const env={...parent};
 for(const key of Object.keys(env))if(/^(?:IDMS_|KEYCLOAK_|MQTT_|FLOWABLE_|AI_GATEWAY_)/.test(key)||['DATABASE_URL','TIMESCALE_DATABASE_URL','APP_PUBLIC_ORIGIN'].includes(key))delete env[key];
 return {...env,PORT:String(port),IDMS_AUTH_MODE:'demo',IDMS_STORAGE:'file',IDMS_DEMO_NAMESPACE:namespace};
}
export function launchDemo({root=process.cwd(),port=4010,namespace='packaged-demo',parent=process.env,stdio='inherit'}={}){return spawn(process.execPath,['server/index.ts'],{cwd:resolve(root),env:demoEnvironment(parent,{port,namespace}),stdio,windowsHide:true});}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--port'&&/^[1-9][0-9]{0,4}$/.test(args[1])))throw Error('Use --port NUMBER for a different local demo port');const port=args.length?Number(args[1]):4010;
 console.log('Isolated file demo on loopback. No enterprise identity, database or device connection is configured.');const child=launchDemo({port});for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill());
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{process.exitCode=code||0;resolve();});});
}
