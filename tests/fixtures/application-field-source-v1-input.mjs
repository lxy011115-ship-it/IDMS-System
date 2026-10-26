import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import * as crypto from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {backupDirectory} from '../../scripts/field-backup-io.mjs';
import {privateDirectory,privateNewFile} from '../../scripts/backup-support.mjs';
import * as config1 from '../../scripts/runtime-application-config-v1.mjs';
import * as config2 from '../../scripts/runtime-application-config-v2.mjs';
import {fieldSiteChildRetirementV1} from '../../scripts/runtime-field-site-retirement-v1.mjs';
import {fieldApplicationManifestV2,fieldSiteTerminalFixtureV1} from './field-application-v2-input.mjs';

/** Isolated VM protocol model. Its handles and capabilities cannot enter the production module. */
export async function applicationFieldSourceInputV1({enabled=true,omitGraphPin=false}={}){
 const base=process.env.IDMS_APPLICATION_FIELD_SOURCE_UNIT_WORK;if(!base)throw Error('FIELD_SOURCE_UNIT_WORK_REQUIRED');
 const root=path.join(base,crypto.randomUUID()),records=path.join(root,'records');await privateDirectory(records);await privateDirectory(path.join(root,'registry'));
 const manifest=fieldApplicationManifestV2(enabled),manifestFile=path.join(root,'manifest.private.json'),siteFile=path.join(root,'site.json'),auxFile=path.join(root,'aux.private.json');
 const files=new Map([[manifestFile,manifest],[siteFile,{format:1,purpose:'FIELD_MAP_SITE_RUNTIME_V1',baseRuntimeFile:'base.json',field:enabled?{enabled:true,gatewayFile:'gateway.json'}:{enabled:false}}],[path.join(root,'base.json'),{inputFile:'aux.private.json'}],[auxFile,{value:'private-example-value'}],[path.join(root,'gateway.json'),{}],[path.join(root,'trust.json'),{}],[path.join(root,'authority.json'),{}],[path.join(root,'registry','trust.json'),{unitRegistry:true}]]);
 for(const c of manifest.components.filter(c=>c.kind!=='SITE'))files.set(path.join(root,c.runtimeFile),{});
 for(const[file,value]of files)await privateNewFile(file,canonical(value));
 const managerNames=['runtime-application-config-v1.mjs','runtime-application-config-v2.mjs','runtime-application-registry-v2.mjs','runtime-application-manager-v3.mjs','runtime-application-child-v2.mjs','runtime-field-site-child-v1.mjs','runtime-field-site-retirement-v1.mjs','field-map-site-runtime-v1.mjs','field-map-authority-gateway-v1.mjs','field-map-authority-host-v1.mjs'],graph=await config1.collectApplicationJsonGraphV1([manifestFile]),sourcePins=[];
 for(const name of managerNames){const p=await config1.readApplicationFileV1(path.resolve('scripts',name));sourcePins.push({path:p.path,sha256:p.sha256});}
 const header={format:'RUNTIME_APPLICATION_REGISTRY_V2',ownerId:crypto.randomUUID(),ownerPid:0,manifest,pins:[...graph,...sourcePins].filter(p=>!omitGraphPin||p.path!==auxFile)};
 let child,events=[],closed=false,closing=null;
 const site=manifest.components.find(c=>c.kind==='SITE'),siteSha=(await config1.readApplicationFileV1(siteFile)).sha256,manifestSha=config1.applicationHashV1(canonical(manifest)),challenge=crypto.randomBytes(32).toString('hex');
 async function finish(requestId){
  const sitePid=child.pid+manifest.components.length,{result}=fieldSiteTerminalFixtureV1(enabled);
  Object.assign(result,{ownerId:header.ownerId,pid:sitePid,parentPid:child.pid,requestId,configSha256:siteSha,manifestSha256:manifestSha,challengeSha256:config1.applicationHashV1(challenge)});result.runtimeTerminal.requestId=requestId;
  const envelope={ownerId:header.ownerId,parentPid:child.pid,component:site,configSha256:siteSha,manifestSha256:manifestSha,challenge};
  await privateNewFile(path.join(root,'registry','site-launch.private.json'),canonical(envelope));await privateNewFile(path.join(root,'registry','site-result.private.json'),canonical(result));
  const proof=fieldSiteChildRetirementV1(result,{ownerId:header.ownerId,componentId:site.id,pid:sitePid,parentPid:child.pid,configSha256:siteSha,manifestSha256:manifestSha,challenge,enabled,requestId});
  events=manifest.components.flatMap((c,i)=>[{event:'LAUNCH_INTENT',componentId:c.id,kind:c.kind,configSha256:c.kind==='SITE'?siteSha:'c'.repeat(64),challengeSha256:c.kind==='SITE'?config1.applicationHashV1(challenge):'d'.repeat(64)},{event:'READY',componentId:c.id,pid:child.pid+i+1}]);events.push({event:'GROUP_READY'},{event:'GROUP_STOPPING',requestId});
  for(const c of [site,...manifest.components.filter(c=>c.kind!=='SITE')]){const pid=c.kind==='SITE'?sitePid:child.pid+manifest.components.indexOf(c)+1;events.push({event:'STOP_INTENT',componentId:c.id,pid,requestId},{event:'DRAINING',componentId:c.id,pid,requestId},{event:'CLOSED',componentId:c.id,pid,requestId},{event:'EXIT',componentId:c.id,pid,code:0,signal:null});if(c.kind==='SITE')events.push({event:'RETIRED',componentId:c.id,pid,proof});}
  events.push({event:'GROUP_CLOSED'});closed=true;child.emit('message',{event:'APPLICATION_SUITE_CLOSED',requestId,normal:true});child.exitCode=0;child.connected=false;child.stdout.closed=true;child.stderr.closed=true;child.emit('unit-close',{code:0,signal:null});
 }
 const fork=()=>{child=new EventEmitter();Object.assign(child,{pid:800000+crypto.randomInt(100000),exitCode:null,signalCode:null,connected:true,stdout:Object.assign(new EventEmitter(),{closed:false}),stderr:Object.assign(new EventEmitter(),{closed:false})});header.ownerPid=child.pid;child.send=(m,callback)=>{if(m.type==='APPLICATION_SUITE_STOP'&&!closing)closing=finish(m.requestId).catch(e=>child.emit('error',e));callback?.();};queueMicrotask(()=>child.emit('message',{event:'APPLICATION_SUITE_READY',pid:child.pid,ownerId:header.ownerId,components:manifest.components.length,manifestSha256:manifestSha}));return child;};
 const namespaces=new Map([['node:child_process',{fork}],['node:fs',fs],['node:fs/promises',fsp],['node:path',path],['node:url',url],['node:crypto',crypto],['../server/imports.ts',{canonical}],['./field-backup-io.mjs',{backupDirectory}],['./backup-support.mjs',{privateDirectory,privateNewFile}],['./runtime-application-config-v1.mjs',config1],['./runtime-application-config-v2.mjs',config2],['./runtime-field-site-retirement-v1.mjs',{fieldSiteChildRetirementV1}],['./runtime-application-registry-v2.mjs',{readApplicationRegistryV2:async()=>structuredClone({header,events,lifecycle:{groupReady:true,stopping:closed,terminal:closed}})}],['./owned-fork-terminal-v1.mjs',{observeOwnedForkTerminalV1:c=>new Promise((ok,no)=>{c.once('unit-close',ok);c.once('error',no);})}]]);
 const context=vm.createContext({process,Buffer,console,URL,structuredClone,setInterval,clearInterval,setTimeout,clearTimeout,AbortController}),identifier=url.pathToFileURL(path.resolve('scripts/application-lifecycle-v4.mjs')).href,module=new vm.SourceTextModule(await fsp.readFile(path.resolve('scripts/application-lifecycle-v4.mjs'),'utf8'),{context,identifier,initializeImportMeta:m=>{m.url=identifier;}}),linked=new Map();
 await module.link(async specifier=>{if(linked.has(specifier))return linked.get(specifier);const ns=namespaces.get(specifier);if(!ns)throw Error('UNEXPECTED_UNIT_IMPORT '+specifier);const names=Object.keys(ns),m=new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,ns[name]);},{context});linked.set(specifier,m);return m;});await module.evaluate();
 const api=module.namespace,handle=await api.launchApplicationLifecycleV4({manifestFile,workDirectory:records});
 return{api,handle,root,manifestFile,siteFile,auxFile,header,graph,async ready(){return api.bindApplicationLifecycleV4(handle);},async stop(){return api.stopApplicationLifecycleV4(handle);},async cleanup(){if(child.exitCode===null)await api.stopApplicationLifecycleV4(handle).catch(()=>{});await handle.terminal.catch(()=>{});}};
}
