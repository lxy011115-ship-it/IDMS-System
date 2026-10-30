# 安装期工作流只读身份与捕获契约

在原真实 RuntimeFenceProvisionV1 未 sealed、目标 fence 未 finalized 的安装窗口，为工作流数据库建立新专用 reader。通过原类的私有状态品牌和实际 deployment/control/database 绑定检查进入，不接受模拟 provision、既有 reader、任意 SQL 回调或恢复目标补授权。

reader 最初 NOLOGIN/连接上限0；授予原工作流普通表 SELECT 与 public USAGE，禁止所有写权限、对象所有权、成员关系、用户函数与大型对象执行。使用原 addActors 在正式 seal 前登记，保存原 SQL 角色/OID、数据库、定义/BPMN/原工作流权威及完整权限事实。提交或配置结果不明时停止该安装器，不将不确定状态称成功。

只读角色也不能利用其他数据库的 PUBLIC 权限连接 postgres、template1 或业务库。因此安装期在真实 PGDATA 内的原主 HBA 文件前增加该新角色的固定规则：只允许 IPv4 loopback 上连接自己的工作流库，拒绝该角色的其他 IPv4、IPv6 与 Unix socket 连接。保留原 HBA 内容；规则摘要和整文件摘要纳入捕获材料。先安装规则并 reload，再开启新 reader 登录；用实际账户证明目标可读及其他可连接数据库被 HBA 拒绝。失败不发放可用配置。

HBA 与角色准备完成后，原 provision 正常 seal；捕获契约重新核真实 catalog、完整 ACL、原角色和定义，并记录原 fence binding 和 HBA 材料。契约不含密码；实际私密 Java 配置另存安装器工作目录。对调用方给出的摘要本身不授信，捕获必须来自实际安装器及当前 SQL/文件重验。

新增冻结投影仅描述新版本规则：全部业务角色仍 NOLOGIN/0，只给捕获 reader 保留原只读登录属性；只给其工作流库保留有界连接数量，其余业务库连接上限0。投影自身不执行 SQL、不授予权限，必须由后续新版本 cold 协调器认证、持久化及实际执行。旧 cold V1/维护 V4 不修改，也不将投影当作已完成恢复接入。

实际验收包括真实 provision + 独立身份权威、两企业非空工作流、NOLOGIN初始状态、HBA跨库拒绝、真实只读服务、源 seal 前后契约一致、非法对象/阶段/材料漂移拒绝，以及所有原句柄正常退役。整库加密冷恢复与实际 owned reader SQL 能力、真实人审和最终提交仍是后续必需组合工作。
