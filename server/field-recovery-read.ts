import {readFieldMaterial} from '../services/field/profile.ts';
import {fieldRecoveryControl,fieldRecoveryDatabaseBinding,type FieldRecoveryControl} from '../integrations/field-recovery.ts';
import {freezeFieldValue} from '../integrations/field-profile.ts';
import {stable} from '../integrations/telemetry.ts';
import {DomainError} from './service.ts';
import type {FieldRegistrySnapshot} from './field-registry.ts';
import {lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
export interface FieldRecoveryHandle {root:string;name:string;control:Readonly<FieldRecoveryControl>}
export const fieldRecoveryUnavailable=()=>Object.assign(new DomainError(503,'现场恢复围栏未激活或运行身份已过期'),{code:'FIELD_RECOVERY_FENCE_STALE'});
async function noOperation(root:string,name:string){try{await lstat(resolve(root,name+'.operation.lock'));throw Error('Recovery operation is pending');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
async function read(root:string,name:string,tenant:string){await noOperation(root,name);const r=fieldRecoveryControl(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readFieldMaterial(root,name,2048))));await noOperation(root,name);if(r.tenantId!==tenant||r.state!=='ACTIVE'||r.changedAtMs>Date.now())throw Error();return r;}
export async function loadFieldRecoveryHandle(root:string,name:string,tenant:string):Promise<FieldRecoveryHandle>{try{const control=await read(root,name,tenant);freezeFieldValue(control);return Object.freeze({root,name,control});}catch{throw fieldRecoveryUnavailable();}}
export function assertFieldRecoveryDatabase(handle:FieldRecoveryHandle,binding:{host:string;port:number;database:string;user:string}){try{if(fieldRecoveryDatabaseBinding(binding)!==handle.control.identity.databaseBindingSha256)throw Error();}catch{throw fieldRecoveryUnavailable();}}
export function assertFieldRecoveryRegistry(handle:FieldRecoveryHandle,snapshot:FieldRegistrySnapshot){if(snapshot.format!=='idms-field-registry-v2'||snapshot.tenantId!==handle.control.tenantId||stable(snapshot.recovery)!==stable(handle.control.identity))throw fieldRecoveryUnavailable();}
export async function verifyFieldRecoveryHandle(handle:FieldRecoveryHandle|undefined){if(!handle)return;try{if(stable(await read(handle.root,handle.name,handle.control.tenantId))!==stable(handle.control))throw Error();}catch{throw fieldRecoveryUnavailable();}}
