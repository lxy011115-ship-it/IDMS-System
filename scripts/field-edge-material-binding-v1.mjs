import {createHmac} from 'node:crypto';
import {canonical} from '../server/imports.ts';

// Loaded configuration only: parsing, path/alias checks and credential checks
// remain with the existing activation-material and edge-configuration loaders.
// A fresh owner key prevents public evidence exposing password/key digests.
export function fieldEdgeMaterialMacV1(c,key){
  if(!Buffer.isBuffer(key)||key.length!==32)throw Error('FIELD_EDGE_OWNER_KEY_REQUIRED');
  return createHmac('sha256',key).update(canonical({root:c.root,profile:c.profile,publicProfile:c.publicProfile,opcua:c.opcua,lease:{...c.lease,publicKey:c.lease.publicKey.export({type:'spki',format:'pem'})},eventKey:c.eventKey,mqtt:c.mqtt,spool:c.spool,schedule:c.schedule})).digest('hex');
}
