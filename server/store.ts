import type { Alarm, Approval, AuditEvent, Device, MaintenanceRecommendation, Plugin, PredictiveAlert, PredictiveModelVersion, HealthSnapshot, TemplateVersion, Tenant, WorkOrder } from "./domain.ts";

const now = new Date().toISOString();
export interface Store { tenants: Tenant[]; devices: Device[]; alarms: Alarm[]; approvals: Approval[]; audits: AuditEvent[]; templates: TemplateVersion[]; plugins: Plugin[]; healthSnapshots: HealthSnapshot[]; predictiveAlerts: PredictiveAlert[]; maintenanceRecommendations: MaintenanceRecommendation[]; predictiveModels: PredictiveModelVersion[]; workOrders: WorkOrder[]; idempotency: Map<string, unknown> }

export function seedStore(): Store {
  const tenants: Tenant[] = [
    { id: "acme", name: "华东精工", plan: "Enterprise", status: "ACTIVE", modules: ["equipment", "alarm", "maintenance", "quality", "ai"] },
    { id: "sandbox", name: "演示沙箱", plan: "Trial", status: "ACTIVE", modules: ["equipment", "alarm"] }
  ];
  const devices: Device[] = [
    ["D-001", "CNC-01 数控车床", "机加一线", "RUNNING", 86.4, 142, 36], ["D-002", "CNC-02 数控车床", "机加一线", "ALARM", 68.1, 91, 54],
    ["D-003", "ASM-01 装配单元", "装配二线", "IDLE", 79.8, 188, 29], ["D-004", "INS-01 视觉检测", "装配二线", "RUNNING", 92.3, 230, 18],
    ["D-005", "PKG-01 包装机", "包装线", "DOWN", 61.9, 76, 67]
  ].map((d, i) => ({ id: `dev-${i + 1}`, tenantId: "acme", code: d[0] as string, name: d[1] as string, line: d[2] as string, status: d[3] as Device["status"], oee: d[4] as number, mtbf: d[5] as number, mttr: d[6] as number, updatedAt: now }));
  const alarms: Alarm[] = [
    { id: "alm-2408", tenantId: "acme", deviceId: "dev-2", title: "主轴振动持续超限", severity: "HIGH", state: "AWAITING_APPROVAL", assignee: "王工", createdAt: now, updatedAt: now, version: 4,
      aiReview: { conclusion: "轴承磨损概率较高，维修措施证据充分", confidence: 0.91, evidence: ["振动 RMS 连续 18 分钟超限", "近 30 天同类报警 3 次", "知识条目 KB-017"], anomalies: [], recommendedAction: "更换主轴前轴承并复测振动", risk: "HIGH", modelVersion: "idms-review-1.0", status: "AUTO_REVIEWED" } },
    { id: "alm-2411", tenantId: "acme", deviceId: "dev-5", title: "输送电机过载", severity: "CRITICAL", state: "REPAIRING", assignee: "李工", createdAt: now, updatedAt: now, version: 2 },
    { id: "alm-2414", tenantId: "acme", deviceId: "dev-3", title: "节拍偏离基线", severity: "MEDIUM", state: "OPEN", createdAt: now, updatedAt: now, version: 1 }
  ];
  const healthSnapshots: HealthSnapshot[] = [
    { id: "health-001", tenantId: "acme", deviceId: "dev-2", deviceCode: "D-002", capturedAt: now, score: 62, band: "RISK", confidence: 0.91, inputWindow: "过去 18 分钟 / 6,480 个点", modelVersion: "cnc-spindle-health-0.3.0", features: [
      { name: "vibration_rms", label: "主轴振动 RMS", value: 7.8, unit: "mm/s", baseline: 4.2, status: "CRITICAL" },
      { name: "bearing_temperature", label: "轴承温度", value: 71, unit: "°C", baseline: 61, status: "ELEVATED" },
      { name: "motor_current_std", label: "电流波动", value: 12.4, unit: "%", baseline: 8.0, status: "ELEVATED" }
    ] },
    { id: "health-002", tenantId: "acme", deviceId: "dev-1", deviceCode: "D-001", capturedAt: now, score: 88, band: "HEALTHY", confidence: 0.86, inputWindow: "过去 18 分钟 / 6,480 个点", modelVersion: "cnc-spindle-health-0.3.0", features: [
      { name: "vibration_rms", label: "主轴振动 RMS", value: 3.1, unit: "mm/s", baseline: 4.2, status: "NORMAL" },
      { name: "bearing_temperature", label: "轴承温度", value: 59, unit: "°C", baseline: 61, status: "NORMAL" },
      { name: "motor_current_std", label: "电流波动", value: 6.2, unit: "%", baseline: 8.0, status: "NORMAL" }
    ] },
    { id: "health-003", tenantId: "acme", deviceId: "dev-3", deviceCode: "D-003", capturedAt: now, score: 74, band: "WATCH", confidence: 0.79, inputWindow: "过去 18 分钟 / 6,480 个点", modelVersion: "cnc-spindle-health-0.3.0", features: [
      { name: "vibration_rms", label: "主轴振动 RMS", value: 4.9, unit: "mm/s", baseline: 4.2, status: "ELEVATED" },
      { name: "bearing_temperature", label: "轴承温度", value: 64, unit: "°C", baseline: 61, status: "ELEVATED" },
      { name: "motor_current_std", label: "电流波动", value: 7.8, unit: "%", baseline: 8.0, status: "NORMAL" }
    ] }
  ];
  const predictiveAlerts: PredictiveAlert[] = [{
    id: "palert-001", tenantId: "acme", deviceId: "dev-2", deviceCode: "D-002", title: "主轴轴承早期磨损风险", severity: "HIGH", state: "AWAITING_APPROVAL", version: 1, healthScore: 62, anomalyScore: 0.89, probability: 0.78, horizon: "未来 7 天（固定场景样例）", generatedAt: now,
    evidence: ["振动 RMS 18 分钟持续高于基线 85%", "轴承温度较基线上升 10°C", "近 30 天同设备出现 3 次相似事件"], recommendation: "安排下一次计划停机更换前轴承，并在复测后关闭预测告警", modelVersion: "cnc-spindle-health-0.3.0"
  }];
  const maintenanceRecommendations: MaintenanceRecommendation[] = [{ id: "mrec-001", tenantId: "acme", alertId: "palert-001", deviceId: "dev-2", action: "更换主轴前轴承并复测振动", priority: "P1", estimatedMinutes: 90, parts: ["6205-2RS 轴承", "润滑脂 EP2"], status: "PROPOSED" }];
  const predictiveModels: PredictiveModelVersion[] = [{ id: "model-001", tenantId: "acme", key: "cnc-spindle-health", name: "CNC主轴健康评分", version: "0.3.0", modelType: "STATISTICAL", status: "ACTIVE", precision: 0.86, recall: 0.78, trainedAt: "2026-10-08T09:00:00.000Z", note: "演示模型：规则与统计特征组合，非生产承诺" }, { id: "model-002", tenantId: "acme", key: "cnc-spindle-rul", name: "CNC主轴剩余寿命", version: "0.1.0-shadow", modelType: "ML", status: "SHADOW", trainedAt: "2026-10-10T09:00:00.000Z", note: "影子评测中，证据不足时不输出RUL" }];
  return {
    tenants, devices, alarms, approvals: [], audits: [], healthSnapshots, predictiveAlerts, maintenanceRecommendations, predictiveModels, workOrders: [], idempotency: new Map(),
    templates: [{ id: "tpl-1", tenantId: "acme", templateKey: "discrete-standard", version: "1.2.0", industry: "离散制造", status: "PUBLISHED", manifest: { modules: ["equipment", "alarm", "maintenance", "quality"], minPlatformVersion: "0.1.0" }, createdAt: now }],
    plugins: [{ id: "plg-1", tenantId: "acme", name: "OPC UA 只读适配器", type: "device-adapter", version: "1.0.0", status: "ACTIVE", signed: true, permissions: ["telemetry:write", "device:read"] }]
  };
}
