import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
if(!process.send||process.env.NODE_ENV!=='test'||process.env.IDMS_FIELD_EVIDENCE_QA!=='1')throw Error('Owned offline evidence probe required');
let network=0,children=0;const denied=()=>{network++;throw Error('Offline evidence network forbidden');},spawnDenied=()=>{children++;throw Error('Offline evidence child process forbidden');};
net.Socket.prototype.connect=denied;net.createConnection=denied;net.connect=denied;tls.connect=denied;http.request=denied;http.get=denied;https.request=denied;https.get=denied;dns.lookup=denied;dns.resolve=denied;globalThis.fetch=denied;
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[name]=spawnDenied;syncBuiltinESMExports();
try{await import('../field-evidence-verify.mjs');assert.equal(network,0);assert.equal(children,0);process.send({type:'OFFLINE_ACTIONS',networkAttempts:network,childProcessAttempts:children});}finally{process.disconnect?.();}
