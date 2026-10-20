import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import pg from 'pg';
import {activationCommitDropProxy} from './field-activation-commit-proxy.mjs';
const mode=process.env.IDMS_FIELD_ACTIVATION_OPERATION_QA_MODE;
if(!process.send||process.env.NODE_ENV!=='test'||!['HOLD_BEFORE_COMMIT','DROP_WIRE_COMMIT_REPLY'].includes(mode))throw Error('Owned activation operation probe required');
const arg=n=>process.argv[process.argv.indexOf(n)+1],directory=await realpath(process.env.IDMS_FIELD_ACTIVATION_OPERATION_QA_DIRECTORY),base=await realpath(resolve('work/field-channel-20261017')),rel=relative(base,directory);
if(isAbsolute(rel)||rel.startsWith('..')||!/^formal-archive-[a-f0-9]{10}$/.test(basename(directory))||resolve(arg('--control-file'))!==resolve(directory,'recovery.json')||arg('--action')!=='activate')throw Error('Owned activation paths required');
const authority=JSON.parse(await readFile(arg('--authority-config'))),target=JSON.parse(await readFile(arg('--target-runtime-config'))),account=target.tenants.acme,applicationName='idms-review-root-'+arg('--operation-id');
if(!/^idms_fieldarchivetarget_[a-f0-9]{10}$/.test(account.database)||authority.host!=='127.0.0.1')throw Error('Owned activation database required');
let proxy;
if(mode==='DROP_WIRE_COMMIT_REPLY'){
 proxy=await activationCommitDropProxy({host:authority.host,port:authority.port,database:account.database,applicationName});
 const connect=pg.Client.prototype.connect;
 pg.Client.prototype.connect=function(...args){if(this.connectionParameters.application_name===applicationName){if(this.connectionParameters.database!==account.database||this.connectionParameters.user!=='idms_bootstrap'||this.connectionParameters.port!==authority.port)throw Error('Unexpected proxy target');this.connectionParameters.port=proxy.port;this.port=proxy.port;}return connect.apply(this,args);};
}else{
 const query=pg.Client.prototype.query;
 pg.Client.prototype.query=function(...args){if(typeof args[0]==='string'&&args[0]==='/* IDMS_FIELD_ACTIVATION_COMMIT */ COMMIT'){process.send({type:'BEFORE_COMMIT',backend:this.processID});return new Promise(()=>{});}return query.apply(this,args);};
}
try{await import('../field-activate.mjs');if(proxy)process.send({type:'WIRE_COMMIT_PROOF',actualStartupMatched:proxy.startupMatched,actualActivationCommitQueryObserved:proxy.activationCommitQueryObserved,actualServerCommitCompletionDiscarded:proxy.dropped});}
finally{await proxy?.close();process.disconnect?.();}
