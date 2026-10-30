# 核心依赖控制器说明

`scripts/platform-dependency-controller-v1.mjs` 为 PG、身份、工作流和应用组提供固定的启动/停止顺序。它是开发中的核心 API，尚无这四类服务共同由它管理的实际原生证明。应用组适配层已有独立 Windows 正例，不能替代此控制器的组合验收。

## 输入准备

使用 `platformDependencyConfigV1` 的严格字段。根清单含 `format:1`、`purpose:PLATFORM_DEPENDENCIES_V1`、`workDirectory`、`postgres`、`identity`、`workflows`、`applicationManifestFile`。所有路径为绝对路径，账户来自私密配置；不要把真实清单提交到 Git。ID `applications` 为控制器保留。

PG 清单只列出本次允许启动的活动集群。恢复来源目录如必须保持离线，不得加入启动列表。每个 PG 使用已知 system identifier、干净关闭目录、工具目录、回环端口和显式账户。身份引用一个 PG ID，工作流引用其所有 PG ID；端口必须一致，不允许运行目录/记录目录相互包含或位于 PGDATA 内。身份数据库、租户库、角色、权限和运行恢复准入必须预先受控准备，控制器不隐式迁移或重置数据。

Java 用显式 `javaHome`，身份用已准备的 Keycloak 目录，工作流用固定 JAR 摘要和 runtime/cancel/reservation 配置；未启用文件显式为 null。记录父目录须预先存在。Windows 控制器必须非管理员，Linux 必须非 root；PG 对管理员 token 的拒绝仍生效。

## 保留实际控制器

```js
import {randomUUID} from 'node:crypto';
import {createPlatformDependenciesV1} from './scripts/platform-dependency-controller-v1.mjs';

const platform = await createPlatformDependenciesV1(privateConfig);
// platform 在服务创建前返回。即使 ready 拒绝，也保留该对象。
try {
  await platform.ready;
} catch {
  console.error(platform.status().failure);
}
const requestId = randomUUID();
const result = await platform.close({requestId});
// 若 result.phase 为 BLOCKED，保留控制器进程与真实 resources() 句柄。
// 修正前置条件后，使用相同 requestId 重试 close；不要从 PID 重建所有权。
```

启动按 PG → 身份/工作流 → 应用组顺序执行，应用组内部先后台后网站。服务创建后即保留实际生命周期句柄；PG 核 SQL 身份，JVM 核实际内部绑定及服务响应，应用组核登记与 IPC。启动取消会阻止后续创建，并向已创建的应用组发送同编号的取消请求；不把部分启动记为整组 READY。

停止先撤应用入口并排空后台，再正常停止工作流、身份，最后等待 PG 客户端和 prepared transactions 排空后 smart stop。原模块的实际退出与正常关闭证明继续有效。重复已接受操作复用原 promise；停止前受阻可以修正后重试。未知结果保留实际句柄，不发强制信号，不删除 PID 文件，不自动创建第二组。

`status()` 返回阶段和阻碍代码；`resources()` 返回本次真正创建的模块句柄，仅供受信控制器使用。`closed` 等待所有自有资源退役，在 BLOCKED 时可继续等待；`close()` 的当次结果先报告阻碍。私密目录保存意图、事件和退役证明，日志/凭据不作为公开输出。配置漂移和异常退出会触发撤入口与逆序排空；不确定的 PG 异常退出不冒充正常停止。

## 当前验证

清单预检5项、应用适配层3项和控制器创建服务前取消检查通过。Windows 新原生27项及独立清理验证的是应用组适配层和已有恢复链，核心控制器共同启停仍未验证。Linux 结果以新工作流的实际执行记录为准。

接续工作是核心组合原生验证、启用时的 broker/边缘/预测/AI/模型登记、旧 owner 可信移交和原方案剩余验收。网站未备案只做服务器准备；此 API 不自动切换原实例或公网。最终用户图文说明与演示视频仍针对最终验收版本制作。
