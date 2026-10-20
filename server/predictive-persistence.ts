import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "./store.ts";

const namespace = process.env.IDMS_DEMO_NAMESPACE || "local";
const directory = join(process.cwd(), ".demo-data", namespace);
const snapshotFile = join(directory, "predictive.json");

export async function loadPredictive(store: Store) {
  try {
    const saved = JSON.parse(await readFile(snapshotFile, "utf8"));
    if (saved.version !== 1 || !Array.isArray(saved.healthSnapshots) || !Array.isArray(saved.predictiveAlerts) || !Array.isArray(saved.maintenanceRecommendations) || !Array.isArray(saved.predictiveModels)) throw new Error("预测快照格式错误");
    const tenantIds = new Set(store.tenants.map(tenant => tenant.id));
    const valid = (items: unknown[]) => items.filter(item => item && typeof item === "object" && tenantIds.has(String((item as { tenantId?: unknown }).tenantId)));
    store.healthSnapshots = valid(saved.healthSnapshots) as Store["healthSnapshots"];
    store.predictiveAlerts = valid(saved.predictiveAlerts) as Store["predictiveAlerts"];
    store.maintenanceRecommendations = valid(saved.maintenanceRecommendations) as Store["maintenanceRecommendations"];
    store.predictiveModels = valid(saved.predictiveModels) as Store["predictiveModels"];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`预测维护演示数据加载失败：${(error as Error).message}`);
  }
}

// Read-only legacy migration. All new writes use the single version-2 transaction in import-api.ts.
