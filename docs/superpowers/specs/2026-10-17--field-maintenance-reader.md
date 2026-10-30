# 恢复维护只读入口与独立终审衔接

沿用完整备份设计第23行和现场通道第6项已确认范围：源持久停写，目标已完整恢复，FIELD关闭且普通业务不可写，维护只允许恢复核对和独立终审。当前实现先落独立只读维护入口；最终审批、当前OIDC/工作流现态核验与激活继续同一恢复流程，不能以此替代。

## 权限与进程

不复用普通server/index启动路径，该路径会启动写入和后台服务。prepare-maintenance在原authority/操作锁下，仅接受已有不可变restore-result及VERIFIED目标，重做完整认证与现态核验，再于同一导出快照内运行既有基础/现场验证器和只读目录采样。应用、迁移、owner保持NOLOGIN，backup保持SELECT-only；不新增SQL角色或扩大权限。

维护HTTP进程只接收该目标backup账号、OIDC配置和维护清单，不接收authority、迁移、归档密钥或源账号配置。它不启动FIELD/遥测/工作流/AI/出站后台，不加载普通应用运行配置。现阶段为单进程loopback维护入口，NODE_ENV=production拒绝，OS服务账号隔离和商业发布门槛不由本阶段跳过。

## 有效核对清单

维护清单绑定sessionId、30分钟有效期、当前宿主、tenant/operation/backup、目标host/port/DB/角色OID与能力注释、当前RESTORING控制和pending标记/原意图、restore元数据摘要、VERIFIED阶段、完整facts SHA、目录指纹、原捕获上下文及独立OIDC客户端/origin。严格私密新文件创建，不覆盖未知对象；位于operations目录外，客户端配置以预期SHA固定清单。

目录指纹按固定SQL、有界行流覆盖关系语义属性、列/默认/约束/索引/触发器/规则/函数/类型/枚举/范围/default ACL/安全标签，以及数据库/角色设置和全局写入来源。只读取pg_subscription非敏感列，绝不读取其subconninfo。采样角色必须是实际backup且事务READ ONLY；发布基线与既有完整编译验证共用导出快照，不接受仅自报的目录摘要。

HTTP每次核对以两个独立backup会话同快照读取完整facts和目录，复用FROZEN权限/已恢复角色能力检查、实际阶段核对，不能使用skip标志或权限投影。全部匹配后回滚只读快照，再以新事务检查当前角色/目录/阶段与微秒精度根行摘要，并再次核对控制记录。控制、角色、根、目录、阶段、清单或有效期漂移均拒绝，不自动修复或开放业务。权威cluster identity和终审现态仍由持authority的后续恢复操作重新检查，只读清单本身不授予激活权。

## 认证与页面

仅OIDC；独立客户端，严格issuer/audience/azp/签名/时间/tenant和管理员管理角色。复用冻结createAuth的PKCE/nonce/CSRF逻辑，外层用每维护session独立Cookie命名映射，忽略普通业务及其他维护实例Cookie，Cookie寿命不超过维护清单。服务端只允许TENANT或READONLY_TENANT范围的既有system-admin/platform-certifier/tenant-admin/auditor核对当前企业，拒绝越企业、受限设备角色和伪造头。

页面显示恢复操作、目标、完整核对摘要、表/点/回执/审计计数，以及“业务仍关闭，等待当前外部状态和独立终审”。策略引用属于恢复出的历史数据，明确待复核。除了OIDC登录/回调/本地退出，仅GET/HEAD入口；普通业务、FIELD准入及审批/激活写路由不开放。HTTP进程无任意SQL或配置选择接口。

prepare同时创建私密空认证日志，HTTP只打开已有文件，缺失不重建。认证和成功核对事件写入独立HMAC链JSONL，有界、顺序化、落盘后才返回成功；记录身份/企业/角色/动作，不记录令牌、Cookie或CSRF。启动和每次追加核对整链，正文篡改、截断行、错密钥及错session拒绝，保留异常文件。日志位于目标库外，不推进目标根/审计/序列；当前为本机维护日志，尚非有外部不可回滚锚点的终审证据，不能宣称防止有文件控制权的攻击者回滚整段合法历史。最终独立审批仍需独立权威审计。

## 验证与后续

实际v3归档/恢复后prepare、backup真实登录及独立OIDC浏览器登录；证明app/mig登录拒绝、backup写/nextval/SET ROLE拒绝、UI/登录不改目标根/审计/序列。测试错清单/账号/控制/阶段/根/列视图/约束索引触发器函数/default ACL/角色设置、越企业/角色/CSRF/Cookie混淆及中途围栏变化；漂移不自动修复。源仍不可连接，原4010/两企业/66契约/十轮双份快照保持。

后续独立终审必须新建有当前OIDC身份的恢复计划并核验当前外部角色/撤权与工作流状态，由不同主体批准，绑定精确策略引用和新激活身份。它不得信任维护页面或旧备份批准；审批写审计后须发布新的受验证维护锚点，旧清单立即失效。当前只读入口没有审批完成或激活声明。

参考：[PG16 pg_subscription权限](https://www.postgresql.org/docs/16/catalog-pg-subscription.html)、[PG16角色/数据库设置](https://www.postgresql.org/docs/16/catalog-pg-db-role-setting.html)。以本项目实际验证为准。
