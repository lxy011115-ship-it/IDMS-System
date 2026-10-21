import {DomainMapV4} from '../server/domain-map-v4.ts';
import {canonicalEqual} from '../server/canonical-state.ts';
import {validateKeyRing} from '../server/auth-state.ts';
import {reconciliationJobKeyWitnessV1} from '../server/reconciliation-runtime-v1.ts';
import {maintenanceMetadataV4} from '../server/maintenance-map-common-v4.ts';
import {ReconciliationUiStoreV1} from '../server/reconciliation-ui-store-v1.ts';
import {randomUUID} from 'node:crypto';
/** Explicit trusted deployment step, never called by an HTTP or worker loader. */
export async function activateReconciliationUiV1({account,binding,queueBinding,readConfig,jobKeyRing}){
 if(binding.databaseOid!==queueBinding.databaseOid||binding.tenantId!==queueBinding.tenantId||binding.catalogHash!==queueBinding.stateCatalogHash)throw Error('RECON_UI_ACTIVATION_BINDING');await new ReconciliationUiStoreV1(account,queueBinding).probe();const store=new DomainMapV4(account,binding),s=await store.snapshot();let delta;
 try{await maintenanceMetadataV4(s);const domain=await s.get('domain_head','predictive_cancel_domain');if(domain.configuration!==readConfig.configuration)throw Error('RECON_UI_ACTIVATION_DOMAIN');const marker={format:'IDMS_RECONCILIATION_UI_V1',tenantId:binding.tenantId,configuration:readConfig.configuration,queueDeployment:queueBinding.deployment,queueCatalogHash:queueBinding.catalogHash,stateCatalogHash:binding.catalogHash,jobKeyWitness:reconciliationJobKeyWitnessV1(validateKeyRing(jobKeyRing),{deployment:queueBinding.deployment,databaseOid:binding.databaseOid,tenantId:binding.tenantId})},prior=await s.state('domain_head','reconciliation_ui');if(prior.present){if(!canonicalEqual(prior.value,marker))throw Error('RECON_UI_ACTIVATION_CONFLICT');return marker;}delta={head:s.head,marker,ops:[await s.operation('domain_head','reconciliation_ui',marker)]};}finally{await s.close();}
 await store.commit(delta.head,randomUUID(),delta.ops);return delta.marker;
}
