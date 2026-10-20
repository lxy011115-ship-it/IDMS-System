import type {FieldMaterials} from './certificates.ts';
import {parseFieldProfile,fieldProfileDigest} from './profile.ts';
import {PinnedFieldReadOnlyClient,type FieldReadObservation} from './opcua-readonly.ts';
import {FieldLeaseClient} from './lease-client.ts';
import {fieldFailure,FieldChannelError} from './error.ts';
import type {SignedFieldLease} from '../../integrations/field-lease.ts';
import {freezeFieldValue} from '../../integrations/field-profile.ts';
export interface LeasedFieldObservation {format:'idms-leased-field-observation-v1';lease:SignedFieldLease;observation:FieldReadObservation;fieldCommissioned:false}
export class LeasedFieldReadOnlyClient {
 readonly #leaseClient:FieldLeaseClient;readonly #reader:PinnedFieldReadOnlyClient;readonly #unsubscribe:()=>void;readonly #digest:string;#closed=false;#active:Promise<LeasedFieldObservation>|null=null;#controller:AbortController|null=null;#readLeaseId:string|null=null;#revoked=false;
 constructor(profile:unknown,materials:FieldMaterials,leaseClient:FieldLeaseClient){const parsed=parseFieldProfile(profile);this.#digest=fieldProfileDigest(parsed);if(leaseClient.state().profileDigest!==this.#digest)fieldFailure('FIELD_LEASE_PROFILE_MISMATCH');this.#leaseClient=leaseClient;this.#reader=new PinnedFieldReadOnlyClient(parsed,materials,permit=>{this.#leaseClient.authorize(permit);if(!this.#readLeaseId||this.#leaseClient.currentLease().body.leaseId!==this.#readLeaseId)fieldFailure('FIELD_LEASE_CONTEXT_CHANGED');});this.#unsubscribe=leaseClient.onRevoked(()=>{if(this.#readLeaseId){this.#revoked=true;this.#controller?.abort();}});}
 state(){return Object.freeze({closed:this.#closed,active:!!this.#active,reader:this.#reader.state(),lease:this.#leaseClient.state()});}
 async readOnce(options:{signal?:AbortSignal}={}):Promise<LeasedFieldObservation>{
  if(this.#closed)fieldFailure('FIELD_CLIENT_CLOSED');const old=this.#reader.state();if(this.#active||old.active)fieldFailure(old.quarantined?'FIELD_READ_QUARANTINED':'FIELD_READ_BUSY');if(options.signal?.aborted)fieldFailure('FIELD_READ_CANCELLED');const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});this.#controller=controller;this.#revoked=false;
  const work=this.#read(controller.signal);this.#active=work;try{return await work;}catch(e){if(this.#revoked&&e instanceof FieldChannelError)throw new FieldChannelError(e.code.endsWith('_IN_FLIGHT')?'FIELD_LEASE_REVOKED_IN_FLIGHT':'FIELD_LEASE_REVOKED');throw e;}finally{options.signal?.removeEventListener('abort',abort);this.#readLeaseId=null;this.#controller=null;if(this.#active===work)this.#active=null;}
 }
 async #read(signal:AbortSignal):Promise<LeasedFieldObservation>{const lease=await this.#leaseClient.ensureLease({signal});if(signal.aborted)fieldFailure('FIELD_READ_CANCELLED');this.#readLeaseId=lease.body.leaseId;this.#leaseClient.startWatching();const observation=await this.#reader.readOnce({signal});this.#leaseClient.authorize({profileDigest:this.#digest,phase:'AFTER_LEASED_DRAIN'});if(this.#leaseClient.currentLease().body.leaseId!==lease.body.leaseId)fieldFailure('FIELD_LEASE_CONTEXT_CHANGED');const result={format:'idms-leased-field-observation-v1' as const,lease,observation,fieldCommissioned:false as const};freezeFieldValue(result);return result;}
 async close(){this.#closed=true;this.#controller?.abort();await Promise.allSettled([this.#leaseClient.close(),this.#reader.close(),this.#active?.catch(()=>{})]);this.#unsubscribe();}
}
