import {resolve} from 'node:path';
import {verifyDemoPackage} from './package-verify.mjs';
if(process.argv.length!==3)throw Error('Usage: node scripts/package-check.mjs PATH.zip');const r=await verifyDemoPackage(resolve(process.argv[2]));console.log(JSON.stringify({verified:r.verified,files:r.files,expandedBytes:r.expandedBytes,purpose:r.manifest.purpose,externalSignatureVerified:false}));
