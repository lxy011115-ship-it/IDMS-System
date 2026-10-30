import test from 'node:test';
import assert from 'node:assert/strict';
import {fieldSiteChildRetirementV1,assertFieldSiteRetirementProofV1} from '../scripts/runtime-field-site-retirement-v1.mjs';
import {applicationHashV1 as hash} from '../scripts/runtime-application-config-v1.mjs';
import {fieldSiteTerminalFixtureV1} from './fixtures/field-application-v2-input.mjs';

test('retirement summary binds the original child and requires complete resource counts',()=>{
 const {result,expected}=fieldSiteTerminalFixtureV1(),p=fieldSiteChildRetirementV1(result,expected);assert(p.allOwnedResourcesRetired&&p.normalClose);assert.equal(p.counts.hostConnectionsCreated,8);assert.equal(p.counts.ownerConnectionsRetired,1);assert.equal(p.counts.mqttSources,1);
 assert.equal(assertFieldSiteRetirementProofV1(p,{...expected,challengeSha256:hash(expected.challenge)}),p);
 for(const key of ['ownerId','componentId','pid','parentPid','configSha256','manifestSha256','challenge','requestId']){const e={...expected,[key]:typeof expected[key]==='number'?expected[key]+1:'wrong'};assert.throws(()=>fieldSiteChildRetirementV1(result,e),/FIELD_SITE_RESULT_/);}
});

test('closed flags cannot hide SQL locks, retained signing keys, active HTTP, reconnects or missing enabled resources',()=>{
 const {result,expected}=fieldSiteTerminalFixtureV1();
 for(const mutate of [r=>r.runtimeTerminal.state.activeHttp=1,r=>r.runtimeTerminal.state.field=null,r=>r.runtimeTerminal.state.field.host=null,r=>r.runtimeTerminal.state.field.host.connectionsRetired=7,r=>r.runtimeTerminal.state.field.platform.tenants[0].owner.held=true,r=>r.runtimeTerminal.state.field.platform.tenants[0].owner.acquiring=true,r=>r.runtimeTerminal.state.field.platform.tenants[0].owner.connectionsRetired=0,r=>r.runtimeTerminal.state.field.platform.tenants[0].issuer.keyCount=1,r=>r.runtimeTerminal.state.field.platform.tenants[0].receiver.active=1,r=>r.runtimeTerminal.state.field.intake.reconnecting=1,r=>r.runtimeTerminal.state.field.intake.transports[0].closed=false,r=>r.runtimeTerminal.state.field.intake.transports[0].publishing=true,r=>r.runtimeTerminal.state.field.intake.transports[0].connecting=true,r=>r.runtimeTerminal.state.field.intake.transports[0].receiving=1,r=>r.runtimeTerminal.state.field.intake.transports=[]]){const bad=structuredClone(result);mutate(bad);assert.throws(()=>fieldSiteChildRetirementV1(bad,expected),/FIELD_SITE_RESULT_/);}
});

test('unstarted cancellation has zero resources; ready SITE cannot claim absent runtime or disabled field resources',()=>{
 const {result,expected}=fieldSiteTerminalFixtureV1(false);assert.equal(fieldSiteChildRetirementV1(result,expected).counts.mqttSources,0);
 result.ready=false;result.started=false;result.startupCancelled=true;result.runtimeTerminal=null;const p=fieldSiteChildRetirementV1(result,expected);assert(p.startupCancelled&&p.runtimeOwner===null);assert(Object.values(p.counts).every(v=>v===0));
 result.ready=true;assert.throws(()=>fieldSiteChildRetirementV1(result,expected),/FIELD_SITE_RESULT_/);
 const enabled=fieldSiteTerminalFixtureV1();assert.throws(()=>fieldSiteChildRetirementV1(enabled.result,{...enabled.expected,enabled:false}),/FIELD_SITE_RESULT_GATEWAY_RETIRED/);
});
