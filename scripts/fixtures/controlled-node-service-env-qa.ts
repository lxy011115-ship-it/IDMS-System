// Environment bridge keeps the same one-script command contract as ordinary startup.
import {join} from 'node:path';
process.argv.push(join(process.env.IDMS_QA_CONTROL_DIRECTORY!,'drain.json'),process.env.IDMS_QA_CONTROL_DELAY!);
await import('./controlled-node-service-qa.ts');
