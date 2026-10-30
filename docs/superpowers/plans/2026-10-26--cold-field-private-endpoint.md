# 受控传输测试的私有地址与公开摘要绑定

Native5/7af 在取得真实HELD之后、创建受控网络对端之前退出1；公开 profile 的 opcua 只有 endpointSha256，没有实际 endpoint，不能将公开摘要对象当连接配置。原guard、reader、postmaster已正常退出，旧源码/输入/case/失败记录保留。

实现版本6从本次原受控OPC服务器保留 opcuaEndpoint，仅存于测试进程内存。公开profile仍是原公开字段集，不能塞入私有地址改变其合同。新QA解析器在任何文件或对端访问之前，校验私有地址SHA与公开 endpointSha256 一致，并限定本测试的原loopback端点、协议、端口和路径，拒绝用户信息、查询和片段。原证书与私钥仍由该原受控对端复制，生产current-materials-v2未修改。

6项测试使用已接受Native4真实公开profile和原私有地址，覆盖摘要匹配、公开对象无地址、改地址不改摘要、即使改摘要也不能越过测试端点边界、畸形profile和在I/O前拒绝。新Native6/cleanup6/helper5/sourceQA4/peerQA2使用新目录和原受限隐藏job，不重开失败Native5。

报告数据结构及43项范围未改变，因此保留报告协议 IDMS_FIELD_CURRENT_MATERIALS_NATIVE_QA_V5 和独立协议 IDMS_FIELD_CURRENT_MATERIALS_INDEPENDENT_V5；实现文件/源码SHA、case目录、原job/input/nonce全部是新版本6，不伪造旧Native5的成功。只有该新原job实际43/normal0/host0后才能运行独立6，再执行future-fixture4的58项测试。其fixture2和contract-test3继续只接受准确已知报告协议4/41或5/43。

完整FIELD/物理设备证明/应用ACL/程序批准/核心材料协调/正式新目的批准/多库最后准入/唯一启用审计/真实COMMIT未知及整站验收仍未完成。
