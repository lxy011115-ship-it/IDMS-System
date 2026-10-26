import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
assert.equal(process.argv.length,3);const mode=process.argv[2];assert(['PASS','FAIL'].includes(mode));console.log(JSON.stringify({nativeStarted:true,pid:process.pid,nonce:randomBytes(6).toString('hex')}));console.log(JSON.stringify({stage:'PORTABLE_FIXTURE_READY'}));if(mode==='PASS')await new Promise(ok=>setTimeout(ok,3000));else process.exitCode=7;
