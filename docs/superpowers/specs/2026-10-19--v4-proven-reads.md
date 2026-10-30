# v4认证查询与历史分页

完整目标仍是所有读写领域及全站切换。本阶段把已运行的采集领域连接到真正HTTP查询，不重新引入全历史重建或直接复用旧SQL表。

选项：每请求全量重构可复用旧API但回到线性成本；SQL投影双写引入第二权威及提交边界；选择已有可信映射根上的认证直接索引/顺序页。现有OIDC createAuth负责签名、issuer/audience/客户端/租户/角色和会话校验，HTTP模块只接它提供的context，不相信请求头身份。

新增只读目录由全量验证后的当前payload的effectiveRecords与legacy devices生成。以治理anchor和内容摘要固定不可变资产/顺序对象，分批准备；最后一次CAS发布read_catalog，半成品不暴露。准备/发布阶段均要求当前ACTIVE和同governanceAnchor，新的治理/资产写者必须同步更换该anchor及目录，旧目录不盲重绑。采集只追加审计/遥测，无需停采集才能准备不可变目录。原站点不修改。

正常请求先验证当前数据库/角色OID、目录、当前head及control、活跃租户和已激活read_catalog。同一REPEATABLE READ连接读取证明，缓存限于本次请求，256键/16MiB上限。历史根只能来自服务器加密认证游标；游标与部署/密钥、主体、租户、角色及管理员范围、路由、页大小、有效期绑定。当前验证先于历史页；当前资产范围和历史资产范围取交集，权限或目录anchor变更要求刷新。读后再次核对目录，成功关闭事务后才能发送正文。

资产页仅返回effective DEVICE；审计页沿audit_order逆序、每次最多扫描48事件，每页最多20事件，验证局部hash及相邻链。返回MAP_PROOF_AND_LOCAL_CHAIN，不声称每页重扫全历史。隐藏事件不会返回；cursor按扫描位置推进，允许空页。遥测回执按edge/event/digest查直接键，核对旧verifySourceReceipt、历史治理、point原点与唯一旧审计。所有受限查询缺scope一律拒绝，不能使用旧内部helper缺scope的兼容豁免。当前与历史资产都需允许。

路径限定为GET /api/v4/data-management/assets、/api/v4/audit、/api/v4/telemetry/receipts/<eventId>；不开放通用namespace、任意root、其他写接口或未集成旧页面。验证用自有PG和真实HTTP/JWKS签名令牌/共享会话及坏token/租户/范围/游标，另与旧有效记录、审计及回执规则独立对比；跨新增采集/新HTTP实例保持旧窗口，篡改旧根证明/目录漂移必须拒绝。所有QA资源精确清理。真实Keycloak整站回归仍后续，不把本地签名JWKS fixture声称为真实Keycloak。
