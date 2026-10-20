import type {EquipmentResolution} from './equipment-profiles.ts';
export type ActorType = "USER" | "AI" | "RULE" | "INTERFACE" | "SYSTEM";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AlarmState = "OPEN" | "ACKNOWLEDGED" | "ASSIGNED" | "REPAIRING" | "AWAITING_APPROVAL" | "CLOSED";

export interface Tenant { id: string; name: string; plan: string; status: "ACTIVE" | "SUSPENDED"; modules: string[] }
export interface Device { id: string; tenantId: string; code: string; name: string; line: string; status: "RUNNING" | "IDLE" | "DOWN" | "ALARM" | "OFFLINE"; oee: number; mtbf: number; mttr: number; updatedAt: string }
export interface Alarm { id: string; tenantId: string; deviceId: string; title: string; severity: RiskLevel; state: AlarmState; assignee?: string; aiReview?: AiReview; createdAt: string; updatedAt: string; version: number }
export interface AiReview { conclusion: string; confidence: number; evidence: string[]; anomalies: string[]; recommendedAction: string; risk: RiskLevel; modelVersion: string; status: "AUTO_REVIEWED" | "HUMAN_REQUIRED" }
export interface Approval { id: string; tenantId: string; objectType: string; objectId: string; decision: "APPROVED" | "REJECTED" | "RETURNED"; approver: string; comment: string; signature: string; decidedAt: string }
export interface AuditEvent { eventId: string; tenantId: string; objectType: string; objectId: string; action: string; actorType: ActorType; actorId: string; correlationId: string; businessTime: string; before?: unknown; after?: unknown; metadata: Record<string, unknown>; previousHash: string; hash: string }
export interface TemplateVersion { equipmentResolution?:EquipmentResolution; id: string; tenantId: string; templateKey: string; version: string; industry: string; status: "DRAFT" | "AWAITING_APPROVAL" | "PUBLISHED" | "RETIRED" | "RETURNED" | "REJECTED"; parent?: string; manifest: Record<string, unknown>; createdAt: string; createdBy?: string; contributors?:string[]; contentDigest?: string; revision?: number; editedBy?:string; submittedBy?: string; publishedAt?: string; publishedBy?: string; approvalComment?: string }
export interface Plugin { id: string; tenantId: string; name: string; type: "device-adapter" | "business-connector" | "metric-provider" | "workflow-action" | "ai-tool" | "report-widget"; version: string; status: "DRAFT" | "CERTIFIED" | "ACTIVE"; signed: boolean; permissions: string[]; manifest?: Record<string, unknown>; contentDigest?: string; signature?: string; publicKey?: string; signingKeyId?:string; createdBy?: string; certifiedAt?: string; certifiedBy?: string; activatedAt?: string; activatedBy?: string }

export type HealthBand = "HEALTHY" | "WATCH" | "RISK" | "CRITICAL";
export type PredictiveAlertState = "OPEN" | "AWAITING_APPROVAL" | "WORK_ORDER_CREATED" | "RESOLVED" | "DISMISSED";
export interface HealthSnapshot {
  id: string;
  tenantId: string;
  deviceId: string;
  deviceCode: string;
  capturedAt: string;
  score: number;
  band: HealthBand;
  confidence: number | null;
  features: { name: string; label: string; value: number; unit: string; baseline: number; status: "NORMAL" | "ELEVATED" | "CRITICAL" }[];
  modelVersion: string;
  inputWindow: string;
  inputDigest?: string;
  sourceBatchIds?: string[];
  provenance?: "SAMPLE" | "APPROVED_IMPORT" | "SIMULATED_TELEMETRY" | "LIVE_TELEMETRY";
  sourceEdgeId?:string;
  sourceEventIds?:string[];
  evaluatedAt?: string;
}
export interface PredictiveAlert {
  id: string;
  tenantId: string;
  deviceId: string;
  deviceCode: string;
  title: string;
  severity: RiskLevel;
  state: PredictiveAlertState;
  healthScore: number;
  anomalyScore: number;
  probability: number | null;
  horizon: string;
  evidence: string[];
  recommendation: string;
  modelVersion: string;
  generatedAt: string;
  approvedBy?: string;
  approvalComment?: string;
  approvedAt?: string;
  version: number;
  workOrderId?: string;
}
export interface MaintenanceRecommendation {
  id: string;
  tenantId: string;
  alertId: string;
  deviceId: string;
  action: string;
  priority: "P1" | "P2" | "P3";
  estimatedMinutes: number;
  parts: string[];
  status: "PROPOSED" | "APPROVED" | "REJECTED" | "EXECUTED";
}
export interface PredictiveModelVersion {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  version: string;
  modelType: "RULE" | "STATISTICAL" | "ML" | "LLM_ASSIST";
  status: "SHADOW" | "ACTIVE" | "RETIRED";
  precision?: number;
  recall?: number;
  trainedAt: string;
  note: string;
}

export interface WorkOrder {
  templateBinding?: MaintenanceTemplateBinding;
  workflow?: {engine:'Flowable';status:'PENDING'|'SYNCED'|'HUMAN_REVIEW';commandId:string;processInstanceId?:string;definitionId?:string;taskKey?:string;lastError?:string};
  id: string; tenantId: string; alertId: string; deviceId: string; deviceCode: string;
  title: string; state: "UNASSIGNED" | "ASSIGNED" | "IN_PROGRESS" | "AWAITING_APPROVAL" | "CLOSED";
  assignee: string; createdBy: string; createdAt: string; updatedAt: string; version: number;
  modelVersion: string; recommendation: string; parts: string[];
  resolution?: { failureCode: string; cause: string; action: string; verification: string; minutes: number; partsUsed: string[]; submittedBy: string; submittedAt: string; digest: string; customFields?:Record<string,string|number|boolean>; templateDigest?:string };
  approval?: { decision: string; approver: string; comment: string; at: string; signature: string };
}

export interface MaintenanceField { key:string; label:string; type:'TEXT'|'NUMBER'|'BOOLEAN'|'SELECT'; required:boolean; unit?:string; min?:number; max?:number; maxLength?:number; options?:string[] }
export interface MaintenanceTemplateBinding { templateId:string; templateKey:string; version:string; contentDigest:string; fields:MaintenanceField[]; bindingDigest:string }
