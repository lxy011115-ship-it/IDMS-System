# 新用户确认的同案例独立重建

新消费者不导入生产Journal、Gate、Control或当前用户读取器，也不调用目标SQL、OIDC或MQTT。完整案例入口先保留原metadata v3独立核验（原SOURCE/旧review/私密文件身份、INTENT/ROW/两anchor、程序清单及当前权威head），再从原控制SQLite读取唯一用户确认行和记录anchor，不通过生产状态API取得结论。

固定路径读取本案例新ctx文件、原user-request、原core配置及所有HTTP成员auth设置、签名authority日志和原current-actors配置。新确认的actor必须对应原完整材料观察中的真实author；issuer/audience/human client/UUID来自这些独立原材料，不接受记录自身声明作来源。读取前后校验普通单链接文件、真实路径、完整字节、inode等身份和摘要保持。

逐字验证精确表结构和4个唯一索引、唯一行/记录anchor的独立HMAC域、原新用途/所有输入/确认ID和时间、原ctx半小时期限和新证明30秒期限。三组每企业的私密身份记录均重新用原令牌、公钥验证RSA签名，并独立重建当前realm/client/user/权限/范围/唯一会话及撤销时限；签名权威head及准确marker、role/tenant和作者ID同时绑定。生产者的true字段不能替代以上检查。

测试层使用实际私密文件/SQLite提交和签名HTTP协议夹具生成新记录；涵盖删除/改动/schema、重摘要并重新签名后的语义错误、错误JWT签名、跨用途、延长时限、缺企业及权威签名错误。它验证新消费者，不重跑旧16/24/8组件。完整Native17/64原case尚未终态时只能做组件/静态预检，不能写同案例独立通过。
