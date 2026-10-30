import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {runWorkflowFreeze} from './workflow-freeze-control.mjs';
const input={};for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i],value=process.argv[i+1];if(!['--config','--operation','--action'].includes(name)||Object.hasOwn(input,name)||!value)throw Error('WF_FENCE_ARGUMENTS');input[name]=value;}
if(Object.keys(input).length!==3||!isAbsolute(input['--config']))throw Error('WF_FENCE_ARGUMENTS');
const info=await lstat(input['--config']);if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw Error('WF_FENCE_CONFIG_FILE');
try{const config=JSON.parse(await readFile(input['--config'],'utf8')),result=await runWorkflowFreeze(config,input['--operation'],input['--action']);console.log(JSON.stringify(result));}
catch(e){console.error(typeof e.code==='string'&&e.code.startsWith('WF_')?e.code:'WF_FENCE_FAILED');process.exitCode=1;}
