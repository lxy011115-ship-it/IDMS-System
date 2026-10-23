import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {launchApplicationSuiteV2} from './runtime-application-manager-v2.mjs';

test('a startup already cancelled performs no config read, directory creation or child launch',async()=>{
 const missing=join(tmpdir(),'idms-never-created-'+randomUUID(),'suite.json'),controller=new AbortController();controller.abort();
 await assert.rejects(launchApplicationSuiteV2(missing,{startupSignal:controller.signal}),error=>error.message==='APPLICATION_SUITE_START_CANCELLED'&&error.shutdown.allOwnedChildrenTerminal===true&&error.shutdown.components===0);
 await assert.rejects(lstat(missing),{code:'ENOENT'});
});
