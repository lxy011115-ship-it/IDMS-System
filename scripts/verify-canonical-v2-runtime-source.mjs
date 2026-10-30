import assert from 'node:assert/strict';
import {verifyCoreRuntimeSource} from './core-managed-entry.mjs';
const args=process.argv.slice(2),values={};assert.equal(args.length,6);for(let i=0;i<args.length;i+=2){assert.ok(['--root','--manifest','--expected-sha256'].includes(args[i])&&!values[args[i]]);values[args[i]]=args[i+1];}assert.equal(Object.keys(values).length,3);console.log(JSON.stringify(await verifyCoreRuntimeSource({root:values['--root'],manifestFile:values['--manifest'],expectedManifestSha256:values['--expected-sha256']})));
