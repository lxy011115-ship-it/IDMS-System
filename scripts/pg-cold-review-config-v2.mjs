import {coldConfigV1,coldConfigNamesV1} from './pg-cold-image-config-v1.mjs';
import {coldManifestV1,coldNeedV1 as need,coldExactV1,coldUuidV1,coldHashV1} from './pg-cold-image-portable-manifest-v1.mjs';
import {workflowReaderHbaPrefixV1} from './workflow-review-source-hba-v1.mjs';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
export {coldConfigNamesV1};
export function coldReviewImageEvidenceV2(e){
 need(coldExactV1(e,['purpose','coldControlId','sourceHash','maintenanceOperationId','readerHba'])&&e.purpose==='PERSISTENT_R4_COLD_REVIEW_CONTROL_V2'&&coldUuidV1(e.coldControlId)&&coldHashV1(e.sourceHash)&&coldUuidV1(e.maintenanceOperationId),'COLD_REVIEW_IMAGE_EVIDENCE');
 const h=e.readerHba;need(coldExactV1(h,['format','sha256','prefixSha256','readers'])&&h.format==='COLD_REVIEW_IMAGE_HBA_V2'&&coldHashV1(h.sha256)&&coldHashV1(h.prefixSha256)&&Array.isArray(h.readers)&&h.readers.every(r=>coldExactV1(r,['role','database'])),'COLD_REVIEW_IMAGE_HBA');
 const prefix=workflowReaderHbaPrefixV1(h.readers);need(hash(prefix)===h.prefixSha256,'COLD_REVIEW_IMAGE_HBA_PREFIX');return e;
}
export function coldReviewImageConfigV2(name,bytes,evidence){
 coldReviewImageEvidenceV2(evidence);
 if(name!=='pg_hba.conf')return coldConfigV1(name,bytes);
 need(bytes.length<=1024**2,'COLD_IMAGE_CONFIG_LIMIT');const h=evidence.readerHba,prefix=Buffer.from(workflowReaderHbaPrefixV1(h.readers));need(hash(bytes)===h.sha256&&bytes.subarray(0,prefix.length).equals(prefix),'COLD_REVIEW_IMAGE_HBA_CHANGED');
 // Only the exact authenticated managed prefix is new; the entire remaining
 // configuration still has to satisfy the original loopback/SCRAM profile.
 return coldConfigV1(name,bytes.subarray(prefix.length));
}
export function coldReviewImageManifestV2(v){
 need(v?.format==='IDMS_PG_REVIEW_COLD_IMAGE_V2','COLD_REVIEW_IMAGE_FORMAT');coldReviewImageEvidenceV2(v.evidence);coldManifestV1({...v,format:'IDMS_PG_COLD_IMAGE_V1'});return v;
}
