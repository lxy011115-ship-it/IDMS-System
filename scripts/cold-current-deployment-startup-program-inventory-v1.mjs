import {isAbsolute,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {coldFileHashV1} from './pg-cold-image-portable-tools-v1.mjs';
import {verifyWorkflowLifecycleToolsV1} from './workflow-lifecycle-portable-tools-v1.mjs';
import {verifyWorkflowReaderPeerToolsV2} from './workflow-reader-peer-tools-v2-request-file-v1.mjs';

const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const exact=(value,names)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...names].sort().join(',');
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:canonical(value)).digest('hex'),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const path=value=>typeof value==='string'&&isAbsolute(value)&&resolve(value)===value;
const equal=(a,b)=>canonical(a)===canonical(b);

/** Descriptive file inventory only. No SOURCE/user approval, program startup or execution capability is minted. */
export async function collectColdCurrentDeploymentStartupProgramInventoryV1(raw){
  need(exact(raw,['lifecycleTools','peerTools','readerArtifact','originalProgramInventory','expectedOriginalProgramInventorySha256']),'CURRENT_STARTUP_PROGRAM_INVENTORY_REQUEST');
  const artifact=raw.readerArtifact,old=raw.originalProgramInventory;
  need(exact(artifact,['path','sha256'])&&path(artifact.path)&&hex(artifact.sha256)&&hex(raw.expectedOriginalProgramInventorySha256),'CURRENT_STARTUP_PROGRAM_READER_ARTIFACT');
  need(exact(old,['format','entries','actualStartupProgramsApproved'])&&old.format==='CURRENT_DEPLOYMENT_UNAPPROVED_DIAGNOSTIC_PROGRAM_INPUTS_V1'&&old.actualStartupProgramsApproved===false&&Array.isArray(old.entries)&&old.entries.length===8&&old.entries.every(e=>exact(e,['path','bytes','sha256'])&&path(e.path)&&Number.isSafeInteger(e.bytes)&&e.bytes>0&&e.bytes<=512*1024**2&&hex(e.sha256))&&new Set(old.entries.map(e=>e.path)).size===8&&hash(old)===raw.expectedOriginalProgramInventorySha256,'CURRENT_STARTUP_PROGRAM_ORIGINAL_INVENTORY');
  const originalBytes=canonical(old),artifactBytes=canonical(artifact),lifecycle=await verifyWorkflowLifecycleToolsV1(raw.lifecycleTools),peer=await verifyWorkflowReaderPeerToolsV2(raw.peerTools);
  need(peer.tools===raw.lifecycleTools,'CURRENT_STARTUP_PROGRAM_FOREIGN_PEER_TOOLS');
  need(lifecycle.programs.length===7&&lifecycle.classPins.length===4&&peer.classPins.length===5&&peer.java===lifecycle.java,'CURRENT_STARTUP_PROGRAM_TOOL_COVERAGE');
  const oldPaths=[artifact.path,lifecycle.java,peer.agentJar,...peer.classPins.map(e=>e.path)];need(new Set(oldPaths).size===8&&equal([...oldPaths].sort(),old.entries.map(e=>e.path).sort()),'CURRENT_STARTUP_PROGRAM_ORIGINAL_PATH_SET');
  const groups={readerJar:[artifact.path],jdkProgramsAndRuntimeLibraries:lifecycle.programs.map(e=>e.path),lifecycleAgentJar:[lifecycle.agentJar],lifecycleClasses:lifecycle.classPins.map(e=>e.path),peerAgentJar:[peer.agentJar],peerClasses:peer.classPins.map(e=>e.path)},all=Object.values(groups).flat();need(all.length===19&&new Set(all).size===19&&all.every(path),'CURRENT_STARTUP_PROGRAM_COMPLETE_PATH_SET');
  const entries=[];for(const program of [...all].sort()){const actual=await coldFileHashV1(program,512*1024**2);need(actual.bytes>0,'CURRENT_STARTUP_PROGRAM_EMPTY_FILE');const prior=old.entries.find(e=>e.path===program);if(prior)need(equal(actual,{bytes:prior.bytes,sha256:prior.sha256}),'CURRENT_STARTUP_PROGRAM_ORIGINAL_FILE_CHANGED');if(program===artifact.path)need(actual.sha256===artifact.sha256,'CURRENT_STARTUP_PROGRAM_READER_FILE_CHANGED');entries.push({path:program,...actual});}
  const finalLifecycle=await verifyWorkflowLifecycleToolsV1(raw.lifecycleTools),finalPeer=await verifyWorkflowReaderPeerToolsV2(raw.peerTools);need(finalPeer.tools===raw.lifecycleTools&&finalLifecycle===lifecycle&&equal(groups.jdkProgramsAndRuntimeLibraries,finalLifecycle.programs.map(e=>e.path))&&equal(groups.peerClasses,finalPeer.classPins.map(e=>e.path))&&canonical(old)===originalBytes&&canonical(artifact)===artifactBytes,'CURRENT_STARTUP_PROGRAM_INPUT_CHANGED_DURING_READ');
  const body={format:'CURRENT_DEPLOYMENT_DIAGNOSTIC_STARTUP_PROGRAM_INPUTS_V1',originalProgramInventorySha256:raw.expectedOriginalProgramInventorySha256,groups,entries,descriptiveDataOnly:true,actualSourceAndCurrentUserAuthenticated:false,runtimeArgumentsAndConfigurationIncluded:false,startupAuthorizationGranted:false,programStarted:false,businessWritesEnabled:false,fullGoalComplete:false};return{...body,sha256:hash(body)};
}
