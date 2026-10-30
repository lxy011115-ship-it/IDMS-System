# FIELD 当前HELD材料、账户和身份组合

1. 只能由一致request-file链中的真实HELD session创建新材料owner；在任何文件、SQL、HTTP前校验原WeakMap品牌、trust/recovery绑定。保留原wall+monotonic 30秒与关闭排空。
2. 复用whole文件编译器3，捕获原非空FileSet与空WAL身份以及总私密MAC；每次使用重新完整核验材料MAC和原SOURCE/意图。所有配置账户和host trust/authority必须对应当前恢复目标和实际SOURCE角色/库OID。
3. 在原受守卫SQL事务中读实际pg_authid，复用项目pg驱动的SASL实现校验密码与SCRAM stored/server两键。不开额外业务SQL连接，不要求在冻结目标临时启用LOGIN，不修改口令。独立真实临时PG16测试ASCII/Unicode规范化、错口令、单独错StoredKey/ServerKey、NOLOGIN及原连接数保持。
4. 在同一材料期限内核实际IdentityAuthorityGuard当前头及外部realm，前后与SOURCE sourceAuthority完全一致；原reader/guard peers也前后重验。该组件不是完整核心SQL/目录权限复核的替代。
5. 进一步在原内部permit中执行固定OPCUA只读与MQTT双端TLS；broker应用ACL、实际启动程序批准、全部核心SQL/身份和新目的独立批准仍必须组合通过，再做新Native/独立证明。未通过全部验收前completeFIELD/正式激活/总目标保持false。

SCRAM实现依据项目实际node_modules/pg/lib/crypto/sasl.js和utils.js（测试输入固定其字节），服务端双键核验参照[RFC5802第3节](https://www.rfc-editor.org/rfc/rfc5802#section-3)及[PostgreSQL16 SASL说明](https://www.postgresql.org/docs/16/sasl-authentication.html)。密码准备直接交给本项目实际驱动，以与最终运行客户端保持一致。

执行结果：真实PG16.10八角色8/8 normal0+原host0，临时PG全部smart正常停止，原44材料/两store/四fullmap材料不变。当前材料入口仅完成原brand负例和语法，真实HELD账户/身份正例、完整核心与transport/broker程序批准仍待。最新requirements-status-v29.json。
