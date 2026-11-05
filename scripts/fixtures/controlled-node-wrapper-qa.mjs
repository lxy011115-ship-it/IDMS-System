// Same creator/control functions as existing-platform-child, detached by the test.
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {spawnControlledNode,attachNodeControl} from '../owned-node-control.mjs';
import {processFacts} from '../existing-platform-process.mjs';
const [directory]=process.argv.slice(2),input=JSON.parse(await readFile(join(directory,'input.json'),'utf8'));
process.on('uncaughtExceptionMonitor',error=>writeFileSync(join(directory,'failure.json'),JSON.stringify({code:error.code||null,message:error.message})));
// A single absolute script is the production command shape; fixture arguments use env.
const command={executable:process.execPath,args:[resolve('scripts/fixtures/controlled-node-service-env-qa.ts')],cwd:resolve('.'),env:{...process.env,IDMS_QA_CONTROL_DIRECTORY:directory,IDMS_QA_CONTROL_DELAY:String(input.delay)}};
const {child,nonce}=spawnControlledNode(command),messages=[];let rejected=0;
child.stdout.resume();child.stderr.resume();
const terminal=new Promise(resolve=>{child.once('error',error=>resolve({error:error.code}));child.once('close',(exitCode,signal)=>resolve({exitCode,signal,pipesClosed:true}));});
const ready=new Promise(resolve=>child.on('message',message=>{messages.push(message);if(message.type==='IDMS_QA_READY_V1')resolve();if(message.type==='IDMS_SERVICE_STOP_REJECTED_V1')rejected++;}));
await ready;
for(const invalid of [{nonce:'f'.repeat(64)},{nonce:'汉'.repeat(64)},{service:'main'}])child.send({type:'IDMS_SERVICE_STOP_V1',service:'edge',nonce,requestId:randomUUID(),...invalid});
while(rejected<3)await new Promise(resolve=>setTimeout(resolve,20));
const identity=await processFacts(child.pid),controller=await attachNodeControl(child,nonce,directory,'edge',identity);
await writeFile(join(directory,'capability.json'),JSON.stringify({control:controller.control,rejected}),{flag:'wx'});
const end=await terminal,final=await controller.close(end);
await writeFile(join(directory,'terminal.json'),JSON.stringify({end,final,rejected,drain:JSON.parse(await readFile(join(directory,'drain.json'),'utf8'))}),{flag:'wx'});
