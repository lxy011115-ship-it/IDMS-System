import {open} from 'node:fs/promises';
import {verifyFrozenReportExport} from '../server/report-export.ts';
const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--file'||!args[1])throw Error('Usage: node scripts/verify-frozen-report.mjs --file <export.json>');
const file=await open(args[1],'r');let raw;try{const meta=await file.stat();if(!meta.isFile()||meta.size>134217728)throw Error('Report verification input exceeds 128 MiB or is not a regular file');raw=Buffer.alloc(meta.size);let offset=0;while(offset<raw.length){const {bytesRead}=await file.read(raw,offset,raw.length-offset,null);if(!bytesRead)throw Error('Report input changed during read');offset+=bytesRead;}if((await file.read(Buffer.alloc(1),0,1,null)).bytesRead)throw Error('Report input grew during read');}finally{await file.close();}
console.log(JSON.stringify(verifyFrozenReportExport(JSON.parse(raw.toString('utf8'))),null,2));
