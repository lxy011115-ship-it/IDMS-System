import assert from 'node:assert/strict';
import {sourcePolicyHistory} from '../../server/source-policy-history.ts';
import {sourcePolicySchema} from '../../server/source-policy-schema.ts';
import {publicationIndex} from '../../server/template-history.ts';

/** Preserve one governed edge history; a new template key would make that history ambiguous. */
export function fieldSiteSourceUpgradeQaV1(payload,source,points,now=Date.now()){
 const evidence=publicationIndex(payload.audits,source.tenantId),history=sourcePolicyHistory(payload.business.templates,source.tenantId,source.edgeId,now,id=>evidence.get(id),evidence);
 assert(history.selected,'FIELD_SITE_EXISTING_SOURCE_POLICY_REQUIRED');const prior=history.selected,templateKey=prior.source.templateKey;
 assert.equal(prior.policy.deviceCode,source.deviceCode);const versions=payload.business.templates.filter(t=>t.tenantId===source.tenantId&&t.templateKey===templateKey).map(t=>t.version.split('.').map(Number)).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);
 assert(versions.length&&versions.every(v=>v.length===3&&v.every(n=>Number.isSafeInteger(n)&&n>=0)));const v=[...versions.at(-1)];v[2]++;const version=v.join('.');
 const effectiveAt=Math.max(now+180000,...prior.policy.entries.map(e=>Date.parse(e.effectiveFrom)+1000)),entry={id:'field-after-cold',effectiveFrom:new Date(effectiveAt).toISOString(),reason:'经独立审批在明确未来时间切换至真实只读现场',mapping:{origin:'FIELD',mapVersion:source.mapVersion,points:structuredClone(points)}};
 assert(!prior.policy.entries.some(e=>e.id===entry.id),'FIELD_SITE_SWITCH_ENTRY_EXISTS');const policy=sourcePolicySchema({...structuredClone(prior.policy),changeIntent:'PROSPECTIVE',changeReason:'保留完整既有采集历史，在计划时间启用现场协议',entries:[...structuredClone(prior.policy.entries),entry]});
 return{templateKey,version,effectiveAt,policy,priorSource:structuredClone(prior.source)};
}
