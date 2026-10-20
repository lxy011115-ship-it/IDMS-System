import {X509Certificate} from 'node:crypto';
import {split_der,verify_certificate_der_structure,convertPEMtoDER} from 'node-opcua-crypto';
import {fieldFailure,FieldChannelError} from './error.ts';
export function fieldCertificateDer(bytes:Buffer){
 try{
  if(!Buffer.isBuffer(bytes)||bytes.length<100||bytes.length>262144)fieldFailure('FIELD_CERTIFICATE_INVALID');let der:Buffer;
  const text=bytes.toString('utf8');if(text.includes('-----BEGIN')){if(!/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(text))fieldFailure('FIELD_CERTIFICATE_INVALID');der=convertPEMtoDER(text);}else der=Buffer.from(bytes);
  verify_certificate_der_structure(der);const pieces=split_der(der);if(pieces.length!==1)fieldFailure('FIELD_CERTIFICATE_INVALID');const x=new X509Certificate(der);if(x.raw.length!==der.length)fieldFailure('FIELD_CERTIFICATE_INVALID');return Buffer.from(x.raw);
 }catch(e){if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_CERTIFICATE_INVALID');}
}
