import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {installPgMigratorObservationQaV1} from './fixtures/pg-migrator-observation-v1-qa.mjs';

assert([8,9].includes(process.argv.length),'CORE_MIGRATOR_OBSERVATION_ARGUMENTS');
const entry=resolve('scripts/verify-runtime-application-suite-v20.mjs'),hash=value=>createHash('sha256').update(value).digest('hex');
assert.equal(hash(await readFile(entry)),'d724acab8db94340d1d1a165f27dc0db8919d9c83b879c2ec466ba36b10b50e6');
const sources=['scripts/fixtures/pg-migrator-observation-v1-qa.mjs','scripts/run-core-migrator-observation-v1.mjs','tests/pg-migrator-observation-v1.test.mjs'];
const sourcePins=await Promise.all(sources.map(async path=>({path,sha256:hash(await readFile(path))})));
console.log(JSON.stringify({format:'IDMS_CORE_ORIGINAL_MIGRATOR_OBSERVATION_STARTED_V1',originalEntrySha256:'d724acab8db94340d1d1a165f27dc0db8919d9c83b879c2ec466ba36b10b50e6',sourcePins,sqlOrParametersPrinted:false,credentialsPrinted:false}));
const observer=installPgMigratorObservationQaV1();
// Fixed original entry and unchanged arguments. No --import/NODE_OPTIONS is
// propagated to the original verifier's application child processes.
process.argv[1]=entry;
try{await import('./verify-runtime-application-suite-v20.mjs');}
finally{
  observer.restore();
  for(const pin of sourcePins)assert.equal(hash(await readFile(pin.path)),pin.sha256,'MIGRATOR_OBSERVER_SOURCE_CHANGED');
  console.log(JSON.stringify({format:'IDMS_CORE_ORIGINAL_MIGRATOR_OBSERVATION_CLOSED_V1',...observer.state(),originalEntrySha256:'d724acab8db94340d1d1a165f27dc0db8919d9c83b879c2ec466ba36b10b50e6',originalVerifierRequestedExitCode:process.exitCode??0,actualRootExitNotClaimed:true,originalArgumentsPreserved:true,productionMigrationLogicChanged:false}));
}
