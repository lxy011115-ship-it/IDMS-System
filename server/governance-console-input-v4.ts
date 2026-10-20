import {canonicalDigest,jsonWireClone} from './canonical-state.ts';
import {normalizeGovernanceJobInputV4} from './governance-job-input-v4.ts';
/** File provenance follows the existing import mapping rule; retain the earlier hash for exact replays. */
export async function normalizeGovernanceConsoleInputV4(raw:unknown){const prior=await normalizeGovernanceJobInputV4(raw),legacyRequestHash=canonicalDigest(prior),command=jsonWireClone(prior);if(command.action==='IMPORT_CREATE'&&['CSV','XLSX'].includes(String(command.input.sourceKind)))command.input.sourceKind='MANUAL_FILE';return {command,legacyRequestHash};}
