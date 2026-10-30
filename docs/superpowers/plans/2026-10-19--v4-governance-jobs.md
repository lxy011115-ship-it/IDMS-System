# 治理作业实施计划

1. 新独立schema/最小ingress权限、完整目录及epoch保护；持久enqueue/claim/renew/reauth/cancel/finish函数。
2. 加密命令和授权引用；复用既有身份验证，构建按输入/单实体大小有界的当前范围授权。
3. 受控JSON/CSV/XLSX解析冻结、真实写HTTP接受与状态/重新授权/取消接口。
4. 持久调度与30秒lease/fence；在同一事务完成branch发布+业务回执校验+queue COMMITTED；取消+恢复也原子。
5. 自有真实PG/HTTP/独立Node/提交回复丢失/旧租约迟到/原件/权限全验证，精确QA清理。
6. 构建、旧包及原运行复核，发布真实边界、更新项目记忆；继续全部领域和完整商用目标。
