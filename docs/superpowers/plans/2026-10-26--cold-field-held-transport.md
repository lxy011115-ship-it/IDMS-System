# FIELD 保全会话中的当前材料与隔离传输核验

沿用已批准的冷恢复登记/启用规格；本计划不授予业务写入或正式启用能力。

1. 当前 Native2（job a0adcb00、case bd0c85abaeb6）先完成原32与当前材料9项，必须真实 normal0/check41、原 supervisor host0，然后执行 run-independent-v2.mjs 并核实际正常终态。Native1/792d 的32后测试记录器白名单失败保留，不复用其目标或重跑其原job。
2. 新 cold-field-current-materials-v2.mjs 在原完整文件/SQLite缓存和来源图、原请求文件会话、实际账户SCRAM、前后身份和SQL peer基础上增加 observeTransport。它要求先 verifyCurrent；沿用同一私有材料MAC、原HELD能力与原30000ms总窗口。每个配置通道执行固定只读OPC UA和EDGE/PLATFORM双角色TLS，错误取消并等待全部连接结束。TLS检查不发送MQTT CONNECT，不签发租约或接收业务事件。
3. 新 Native3 使用全新来源与目录，保留原32项逻辑，扩展当前部分为11项，共计划43。来源测试只在原真实FIELD管理器正常退出后保留受控测试对端的内存证书副本；第二轮用原证书/端点启动新的受控OPC UA服务器和原句柄MQTT Broker。材料来自本次真实SOURCE配置及只读复制，不能修改受测配置使其指向任意其他设备。
4. 当前启用分支在真实原reader/guards HELD之后、材料30秒窗口开始之前准备隔离测试对端；verifyCurrent和observeTransport在同一真实只读根SQL事务进行，最终重验材料、身份和原peer。明确关闭分支必须零通道、无新测试对端，不能替代启用正例。
5. 成功或失败均关闭材料/rootSQL、原测试对端、守卫/reader/preparation/postmaster。OPC服务器等待shutdown完成；MQTT必须原ChildProcess、原正常控制事件和真实输出关闭。保存请求计数（Read>0、Write/Call=0）和实际broker正常终态，不收养PID或generic kill。
6. 独立检查器保留原SOURCE完整根/历史/缓存MAC/ACK/证据及所有资源退役核验，再核新观测的完整配置通道覆盖、双角色TLS未发送应用字节、原30秒期限、明确关闭零网络及受控对端真实终态文件。它不重放已停目标的当前SQL/网络，也不将受控测试对端作为物理设备证明。
7. 启动准备器 prepare-launch-v1.mjs 只有在原Native2、其独立任务与本次静态预检都 normal0/原host0后才生成原Native3 job；仍需隐藏受限launcher实际启动。当前只完成源与静态准备，没有43项实际通过或任何独立复核结果。

仍未完成：完整核心材料协调、真实空源流和实际历史密钥/profile轮换、MQTT应用ACL与实际启动程序批准、新目的独立批准、多库最后准入、唯一启用审计/真实COMMIT未知、整站安全容量HA-DR商业验收、最终Git/未备案域名服务器准备和系统目标后的图文及旁白字幕视频。
