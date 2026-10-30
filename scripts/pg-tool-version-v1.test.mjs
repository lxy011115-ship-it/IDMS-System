import test from 'node:test';
import assert from 'node:assert/strict';
import {isPostgres16ToolVersionV1 as valid} from './pg-tool-version-v1.mjs';
test('PostgreSQL 16 release and matching Ubuntu/Debian package labels remain complete inputs',()=>{
 for(const version of ['postgres (PostgreSQL) 16.10','postgres (PostgreSQL) 16.15','postgres (PostgreSQL) 16.15 (Ubuntu 16.15-1.pgdg24.04+2)','postgres (PostgreSQL) 16.15 (Debian 16.15-1.pgdg120+1)','postgres (PostgreSQL) 16.15 (Debian 1:16.15-1)'])assert.equal(valid(version),true,version);
});
test('Other majors, inconsistent package releases and unrecognized labels are refused',()=>{
 for(const version of ['postgres (PostgreSQL) 17.1','postgres (PostgreSQL) 16.15 (Ubuntu 17.1-1)','postgres (PostgreSQL) 16.1 (Ubuntu 16.15-1)','postgres (PostgreSQL) 16.15 (Vendor 16.15-1)','postgres (PostgreSQL) 16.15 (Ubuntu arbitrary)','postgres (PostgreSQL) 16.15 (Ubuntu 16.15-1) trailing','postgres (PostgreSQL) 16.15\n',' postgres (PostgreSQL) 16.15'])assert.equal(valid(version),false,version);
});
test('Version inputs are bounded strings with no control characters or paths',()=>{
 for(const version of [undefined,null,16,{},'postgres (PostgreSQL) 16.15 (Ubuntu 16.15-../../x)','postgres (PostgreSQL) 16.15 (Ubuntu 16.15-1\n)','postgres (PostgreSQL) 16.15 (Ubuntu 16.15-'+ 'a'.repeat(225)+')'])assert.equal(valid(version),false);
});
