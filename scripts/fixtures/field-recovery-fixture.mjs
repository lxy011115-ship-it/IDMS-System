import {randomUUID} from 'node:crypto';
import {fieldRecoveryControl,fieldRecoveryDatabaseBinding} from '../../integrations/field-recovery.ts';
// Owned model/config fixture. This does not perform or attest a restore.
export function fieldRecoveryFixture({tenantId='acme',host='127.0.0.1',port=5432,database='field_fixture',user='field_fixture_app',deploymentId=randomUUID(),activationId=randomUUID(),...overrides}={}){return fieldRecoveryControl({format:'idms-field-recovery-control-v1',tenantId,identity:{format:'idms-field-recovery-identity-v1',deploymentId,activationId,databaseBindingSha256:fieldRecoveryDatabaseBinding({host,port,database,user})},state:'ACTIVE',operationId:null,previousActivationId:null,changedAtMs:Date.now(),...overrides});}
