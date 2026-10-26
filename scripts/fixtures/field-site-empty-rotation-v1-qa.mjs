import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,cp,readdir,lstat} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {randomBytes,randomUUID,generateKeyPairSync} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {FieldMapTransactionsV2} from '../../server/field-map-transaction-v2.ts';
import {FieldMapIssuerV1} from '../../server/field-map-issuer-v1.ts';
import {fieldRegistrySnapshot} from '../../server/field-registry.ts';
import {publicFieldProfile,fieldProfileDigest} from '../../services/field/profile.ts';
import {PinnedFieldReadOnlyClient} from '../../services/field/opcua-readonly.ts';
import {FieldSpool} from '../../services/field/spool.ts';
import {fieldSha256} from '../../integrations/field-profile.ts';
import {fieldLeaseKeyId,verifyFieldLease} from '../../integrations/field-lease.ts';
import {signFieldLeaseRequest} from '../../integrations/field-request.ts';
import {signFieldCheckRequest,verifyFieldCheck} from '../../integrations/field-check.ts';
import {fieldStreamBinding,fieldStreamId} from '../../integrations/field-event.ts';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
import {loadFieldMapAuthorityHostV1} from '../field-map-authority-host-v1.mjs';
import {createFieldMapSiteRuntimeV1} from '../field-map-site-runtime-v1.mjs';
import {readApplicationRegistryV2} from '../runtime-application-registry-v2.mjs';
import {launchApplicationLifecycleV4,bindApplicationLifecycleV4,stopApplicationLifecycleV4,captureOwnedApplicationFieldSourceV1,inspectOwnedApplicationFieldSourceV1,readOwnedApplicationFieldSourcePrivateV1,closeOwnedApplicationFieldSourceV1} from '../application-lifecycle-v4.mjs';

const json=async file=>JSON.parse(await readFile(file,'utf8'));
const save=(file,value)=>writeFile(file,canonical(value));
const identity=stat=>Object.fromEntries(['dev','ino','nlink','size','mtimeNs','ctimeNs'].map(key=>[key,String(stat[key])]));

/** Extends the same actual admitted source; no fixture identity, map seed, ACK, or source graft. */
export async function exerciseFieldSiteEmptyRotationQaV1({work,nonce,site,hostFile,policy,originalDirectory,privateProfile,initialKeys,initialEventKey,requestKey,recovery,initialRegistry,opc,initialSource,children,report,note,setSourceCapability}) {
  assert(initialSource?.capability&&initialSource.manifestFile);
  const stage={format:'FIELD_SITE_EMPTY_ROTATION_ACTUAL_QA_V1',checks:[],rotations:[],streams:[],cleanupErrors:[],actualOidcIdentityAuthenticated:true,actualOriginalColdSourceHeldExecuted:false,controlledOpcuaPeerOnly:true,physicalFieldAttested:false,formalFieldActivationGranted:false,fullGoalComplete:false};report.fieldEmptyRotation=stage;
  const done=name=>{stage.checks.push(name);note(name);};
  const directory=join(work,'field-rotated-site-materials'),original=resolve(originalDirectory),current=resolve(directory),oldEvidence=await inspectOwnedApplicationFieldSourceV1(initialSource.capability),oldPrivate=await readOwnedApplicationFieldSourcePrivateV1(initialSource.capability);
  assert(oldEvidence.actualReadyAndOriginalNormalFullStopVerified&&oldEvidence.originalJsonGraphUnchanged&&oldEvidence.siteFieldEnabled);stage.originalOwnerEvidence=oldEvidence;
  await cp(original,current,{recursive:true,errorOnExist:true,force:false});await privateDirectory(current);
  const rebase=file=>{const r=relative(original,resolve(file));assert(r&&!r.startsWith('..')&&!isAbsolute(r),'FIELD_ROTATION_COPY_PATH');return join(current,r);};
  const initialSpoolNames=(await readdir(join(original,'edge-spool'))).filter(name=>/^stream-[a-f0-9]{64}\.sqlite$/.test(name));assert.equal(initialSpoolNames.length,1);
  const originalSpoolFile=join(original,'edge-spool',initialSpoolNames[0]),originalSpoolHash=fieldSha256(await readFile(originalSpoolFile)),originalSpoolIdentity=identity(await lstat(originalSpoolFile,{bigint:true}));
  assert.equal(fieldSha256(await readFile(join(current,'edge-spool',initialSpoolNames[0]))),originalSpoolHash);
  const historyDirectory=join(current,'historical-materials');await privateDirectory(historyDirectory);const historical=[];
  async function historicalMaterial(label,profile,eventKey,keys,streamId){const root=join(historyDirectory,label.toLowerCase());await privateDirectory(root);const entry={tenantId:profile.source.tenantId,edgeId:profile.source.edgeId,streamId,profileFile:join(root,'profile.json'),eventKeyFile:join(root,'event.bin'),platformPublicKeyFile:join(root,'platform-public.pem')};await privateNewFile(entry.profileFile,canonical(profile));await privateNewFile(entry.eventKeyFile,eventKey);await privateNewFile(entry.platformPublicKeyFile,keys.publicKey.export({type:'spki',format:'pem'}));historical.push(entry);}
  await historicalMaterial('INITIAL',publicFieldProfile(privateProfile),initialEventKey,initialKeys,initialSpoolNames[0].slice(7,-7));
  stage.streams.push({label:'INITIAL',streamId:initialSpoolNames[0].slice(7,-7),originalSpoolSha256:originalSpoolHash,originalNonemptyStreamRetained:true});
  let host,httpRuntime,httpServer,manager,managerStop,newCapability,reader,openSpool;const issuers=[],secrets=[],requestId=randomUUID(),httpErrors=[];
  let profile=structuredClone(privateProfile),eventKey=initialEventKey,keys=initialKeys,latestLease;
  try {
    // The old enabled manager is already normally stopped. Only the browser/queue
    // surface runs during policy changes; no old MQTT client can replay old data.
    const maintenanceSiteFile=join(work,'field-rotation-governance-site.private.json');await privateNewFile(maintenanceSiteFile,canonical({format:1,purpose:'FIELD_MAP_SITE_RUNTIME_V1',baseRuntimeFile:(await json(join(original,'site.json'))).baseRuntimeFile,field:{enabled:false}}));
    httpRuntime=createFieldMapSiteRuntimeV1(maintenanceSiteFile);await httpRuntime.ready;assert(httpRuntime.state().ready);assert.equal(httpRuntime.state().field,null);
    httpServer=createServer((req,res)=>void httpRuntime.handleHttp(req,res).catch(error=>{httpErrors.push({message:error.message,stack:error.stack});if(!res.headersSent){res.writeHead(503);res.end();}else res.destroy();}));httpServer.on('clientError',(_error,socket)=>socket.destroy());await new Promise((ok,no)=>{httpServer.once('error',no);httpServer.listen(Number(new URL(site.origin).port),'127.0.0.1',ok);});
    host=await loadFieldMapAuthorityHostV1(hostFile);const binding=host.tenantBindings().get(profile.source.tenantId),tx=new FieldMapTransactionsV2(binding.account,binding.binding,binding.guard);
    // Private source profiles contain no public origin field. Build the exact wire
    // request explicitly instead of propagating optional or private configuration.
    const request=p=>{const {tenantId,edgeId,deviceCode,mapVersion}=p.source;return signFieldLeaseRequest({format:'idms-field-lease-request-v1',requestId:randomUUID(),tenantId,edgeId,deviceCode,mapVersion,profileDigest:fieldProfileDigest(p),requestedAtMs:Date.now()},requestKey);};
    const initialIssuer=new FieldMapIssuerV1(tx,initialRegistry,initialKeys.privateKey,new Map([[profile.source.edgeId,requestKey]]));issuers.push(initialIssuer);let previousIssuer=initialIssuer;
    for(const kind of ['PROFILE','EVENT_KEY','PLATFORM_KEY']) {
      const previous=profile;profile=structuredClone(previous);
      if(kind==='PROFILE')profile.limits.maxSampleAgeMs+=1000;
      if(kind==='EVENT_KEY'){eventKey=randomBytes(32);secrets.push(eventKey);profile.transport.eventKeySha256=fieldSha256(eventKey);}
      if(kind==='PLATFORM_KEY'){keys=generateKeyPairSync('ed25519');profile.transport.acknowledgementKeyId=fieldLeaseKeyId(keys.publicKey);}
      const approved=await policy.rotate(kind,publicFieldProfile(profile));
      const registry=fieldRegistrySnapshot({format:'idms-field-registry-v2',tenantId:profile.source.tenantId,leaseKeyId:fieldLeaseKeyId(keys.publicKey),recovery:recovery.identity,channels:[{profile:publicFieldProfile(profile),profileDigest:fieldProfileDigest(profile),requestKeySha256:fieldSha256(requestKey)}]}),issuer=new FieldMapIssuerV1(tx,registry,keys.privateKey,new Map([[profile.source.edgeId,requestKey]]));issuers.push(issuer);
      const observed=await issuer.observe('field-rotation-'+nonce),lease=await issuer.issue(request(profile));assert(observed.changed);assert(lease.body.issuedAtMs>=approved.effectiveAtMs);latestLease=lease;
      verifyFieldLease(lease,keys.publicKey,{...registry.channels[0].profile.source,profileDigest:fieldProfileDigest(profile),requestId:lease.body.requestId},Date.now());
      await assert.rejects(previousIssuer.issue(request(previous)),/FIELD_REGISTRY_STALE/);await assert.rejects(issuer.issue(request(previous)),/FIELD_MAP_REQUEST_IDENTITY/);
      const publicProfile=publicFieldProfile(profile),streamId=fieldStreamId(fieldStreamBinding(publicProfile,lease,keys.publicKey)),file=join(current,'edge-spool','stream-'+streamId+'.sqlite');assert(!stage.streams.some(value=>value.streamId===streamId));
      openSpool=new FieldSpool(file,{profile:publicProfile,contextLease:lease,eventKey,platformPublicKey:keys.publicKey,authorize:()=>lease,capacity:profile.points.length,maxBytes:1048576});let observation=null,appended=null;
      if(kind==='EVENT_KEY') {
        opc.state.mode=null;
        const check=async()=>{const raw=signFieldCheckRequest({format:'idms-field-lease-check-request-v1',requestId:randomUUID(),requestedAtMs:Date.now(),lease},requestKey),value=await issuer.checkCurrent(raw);verifyFieldCheck(value,keys.publicKey,{requestId:raw.requestId,requestedAtMs:raw.requestedAtMs,lease},Date.now());assert(value.body.allowed,'FIELD_ROTATION_CURRENT_LEASE_DENIED');};
        await check();reader=new PinnedFieldReadOnlyClient(profile,opc.materials,permit=>{assert.equal(permit.profileDigest,fieldProfileDigest(profile));verifyFieldLease(lease,keys.publicKey,{...publicProfile.source,profileDigest:permit.profileDigest},Date.now());});observation=await reader.readOnce();await reader.close();assert(reader.state().closed&&!reader.state().active);reader=null;await check();
        appended=openSpool.append(randomUUID(),{format:'idms-leased-field-observation-v1',lease,observation,fieldCommissioned:false});assert(!appended.alreadyAppended);
      }
      const stats=openSpool.stats();assert.equal(stats.pending,kind==='EVENT_KEY'?profile.points.length:0);assert.equal(stats.sequence,kind==='EVENT_KEY'?profile.points.length:0);assert.equal(stats.acknowledged,0);openSpool.close();openSpool=null;
      stage.streams.push({label:kind,streamId,stats,lease,profileDigest:fieldProfileDigest(profile),runtimeCreatedEmpty:kind!=='EVENT_KEY',actualSqlLeaseCommitted:true,actualControlledOpcuaRead:kind==='EVENT_KEY'});
      stage.rotations.push({...approved,newLeaseIssuedAtMs:lease.body.issuedAtMs,newRegistryRevision:lease.body.registryRevision,newRegistryDigest:lease.body.registryDigest});
      if(kind!=='PLATFORM_KEY')await historicalMaterial(kind,publicProfile,eventKey,keys,streamId);
      if(observation)await privateNewFile(join(work,'field-rotation-opcua-observation.private.json'),canonical({observation,lease,appended}));
      previousIssuer=issuer;done(kind+' actual OIDC prospective approval and guarded SQL registry/lease create a distinct '+(kind==='EVENT_KEY'?'controlled OPC UA pending stream':'born-empty runtime stream'));
    }
    assert.equal(policy.jobs.length,15);assert.equal(policy.rotations.length,3);assert.equal(historical.length,3);assert.equal(stage.streams.length,4);
    for(const issuer of issuers){await issuer.close();assert(issuer.state().closed&&issuer.state().active===0&&issuer.state().keyCount===0);}await host.close();assert(host.state().closed&&host.state().connectionsActive===0);
    stage.governanceSiteTerminal=await httpRuntime.close({requestId});assert(stage.governanceSiteTerminal.normal&&stage.governanceSiteTerminal.allOwnedResourcesRetired);await new Promise(ok=>httpServer.close(ok));httpServer=null;
    await writeFile(join(current,'profile.json'),canonical(profile));await writeFile(join(current,'event.bin'),eventKey);await writeFile(join(current,'signer.pem'),keys.privateKey.export({type:'pkcs8',format:'pem'}));await writeFile(join(current,'platform-public.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
    const platformFile=join(current,'platform.json'),platform=await json(platformFile);assert.equal(platform.tenants.length,1);assert.equal(platform.tenants[0].channels.length,1);platform.tenants[0].channels[0].profile=publicFieldProfile(profile);await save(platformFile,platform);
    const gatewayFile=join(current,'gateway.json'),gateway=await json(gatewayFile);gateway.platformFile=rebase(gateway.platformFile);gateway.intakeFile=rebase(gateway.intakeFile);await save(gatewayFile,gateway);
    const siteFile=join(current,'site.json'),siteConfig=await json(siteFile);siteConfig.field.gatewayFile=gatewayFile;await save(siteFile,siteConfig);
    const activationFile=join(current,'activation-materials.json'),activation=await json(activationFile);activation.intakeConfigurationFile=rebase(activation.intakeConfigurationFile);for(const edge of activation.edges)edge.configurationFile=rebase(edge.configurationFile);await save(activationFile,activation);
    const brokerFile=join(current,'broker-runtime.private.json'),broker=await json(brokerFile);for(const section of ['server','probe'])for(const name of Object.keys(broker[section]))if(name.endsWith('File'))broker[section][name]=rebase(broker[section][name]);await save(brokerFile,broker);
    await privateNewFile(join(current,'historical-stream-materials.private.json'),canonical(historical));
    const manifest=await json(initialSource.manifestFile);manifest.registryDirectory=join(work,'field-rotated-generation');manifest.components.find(component=>component.kind==='SITE').runtimeFile=siteFile;
    const manifestFile=join(work,'field-rotated-manifest.private.json'),records=join(work,'field-rotated-records');await privateDirectory(records);await privateNewFile(manifestFile,canonical(manifest));
    const finalSpoolFile=join(current,'edge-spool','stream-'+stage.streams.at(-1).streamId+'.sqlite'),finalSpoolBefore=fieldSha256(await readFile(finalSpoolFile));
    manager=await launchApplicationLifecycleV4({manifestFile,workDirectory:records});children.push({process:manager.process,script:'scripts/runtime-application-suite-v3.mjs',lifecycle:manager,lifecycleVersion:4,terminal:manager.terminal});report.children.push({pid:manager.process.pid,script:'scripts/runtime-application-suite-v3.mjs'});await bindApplicationLifecycleV4(manager);
    const trust=await json(join(manifest.registryDirectory,'trust.json')),ready=await readApplicationRegistryV2(trust);assert.equal(ready.events.filter(event=>event.event==='READY').length,9);
    managerStop=await stopApplicationLifecycleV4(manager,{requestId});assert(managerStop.normalFullGroup&&managerStop.allOwnedResourcesRetired&&managerStop.allOwnedTerminalProven);
    newCapability=await captureOwnedApplicationFieldSourceV1(manager);const evidence=await inspectOwnedApplicationFieldSourceV1(newCapability),facts=await readOwnedApplicationFieldSourcePrivateV1(newCapability);
    assert(evidence.actualReadyAndOriginalNormalFullStopVerified&&evidence.originalJsonGraphUnchanged&&evidence.siteFieldEnabled);assert.deepEqual(evidence.tenantIds,['acme','sandbox']);assert.equal(facts.manifestFile,manifestFile);assert.equal(facts.siteRuntimeFile,siteFile);assert.notEqual(evidence.owner,oldEvidence.owner);
    assert.equal((await inspectOwnedApplicationFieldSourceV1(initialSource.capability)).configurationMac,oldEvidence.configurationMac);assert.deepEqual((await readOwnedApplicationFieldSourcePrivateV1(initialSource.capability)).originalTerminal,oldPrivate.originalTerminal);
    assert.equal(fieldSha256(await readFile(originalSpoolFile)),originalSpoolHash);assert.deepEqual(identity(await lstat(originalSpoolFile,{bigint:true})),originalSpoolIdentity);
    const currentStream=stage.streams.at(-1),currentSpool=join(current,'edge-spool','stream-'+currentStream.streamId+'.sqlite');assert.equal(currentStream.stats.pending,0);assert.equal(currentStream.stats.sequence,0);stage.currentSpoolSha256=fieldSha256(await readFile(currentSpool));assert.equal(stage.currentSpoolSha256,finalSpoolBefore);
    stage.currentDirectory=current;stage.currentManifestFile=manifestFile;stage.currentSiteFile=siteFile;stage.currentOwnerEvidence=evidence;stage.currentManagerDirectory=manager.directory;stage.currentManagerTerminal=managerStop;stage.currentProfile=publicFieldProfile(profile);stage.historicalStreamMaterials=historical;stage.allOriginalSpoolBytesAndIdentityUnchanged=true;stage.actualCurrentNineMemberReadyAndNormalStop=true;stage.currentEmptyStreamNoEdgeStarted=true;stage.finalLease=latestLease;assert.deepEqual(httpErrors,[]);
    closeOwnedApplicationFieldSourceV1(initialSource.capability);setSourceCapability({capability:newCapability,manifestFile,originalDirectory:current,historicalStreamMaterials:historical,originalOwnerEvidence:oldEvidence});newCapability=null;
    done('new exact rotated configuration reaches real nine-member READY and original normal retirement; new owner replaces no old configuration or pending evidence');
    return{directory:current,profile:publicFieldProfile(profile),manifestFile,historicalStreamMaterials:historical};
  } finally {
    if(openSpool)openSpool.close();if(reader)await reader.close();for(const issuer of issuers)await issuer.close();if(host)await host.close();
    if(httpRuntime)await httpRuntime.close({requestId});if(httpServer){httpServer.closeAllConnections();await new Promise(ok=>httpServer.close(ok));}
    if(manager&&manager.process.exitCode===null&&manager.process.signalCode===null)await stopApplicationLifecycleV4(manager,{requestId});if(newCapability)closeOwnedApplicationFieldSourceV1(newCapability);closeOwnedApplicationFieldSourceV1(initialSource.capability);for(const bytes of secrets)bytes.fill(0);
    stage.httpErrors=httpErrors;await privateNewFile(join(work,'field-empty-rotation-source-result.private.json'),canonical(stage));
  }
}
