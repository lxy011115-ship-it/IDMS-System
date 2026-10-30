# 恢复读取代理的有界加载参数

原6d0e4fe Linux任务的ACQUIRE和RELEASE均在AGENT_LOAD以java.io.IOException退出。208项Node和16项JVM边界通过，但Native在24项后失败；该任务日志已消费一次，不再读取。另发现观察器的旧入口路径正则未接受新的诊断入口，需要后续新版本修正，不能据此假称目标JVM没有异常。

OpenJDK21 Linux AttachOperation限制每个参数1024字节；loadAgent把agent路径、等号和options拼为一个参数。原Windows实际构造947字节，依照相同已发布路径结构投影到GitHub Linux工作目录为1046字节。后者是显式推算，尚未测得原失败请求的原始字节，也不能代替修复后的Linux正例。

修正仅改变请求传输：原helper完成原agent哈希和目标身份检查后，在原已绑定实例目录CREATE_NEW写入有界UTF8请求文件；loadAgent参数只含固定协议、请求UUID和内容SHA256。agent根据自身原目录属性选择唯一固定文件名，拒绝任意路径、覆盖、符号链接、超限和内容变动，读取后执行原完整五字段和全部原绑定、配置、JAR、Ready、MBean及结果回执检查。文件保留为原请求历史。

不移动工作区、不缩短随机身份、不省略绑定字段，不修改lease、30秒材料窗口、SQL、原资源正常退役或重试规则。原代码冻结，新Attach和Agent必须成对选择；实际完整Windows/Linux证明仍待。独立验证先覆盖真实文件往返、长UTF8、篡改、错误摘要、请求重用、目录切换、缺文件、超限和协议拒绝；旧Java9成功证据复用。

依据：

- https://github.com/openjdk/jdk21u/blob/master/src/hotspot/share/services/attachListener.hpp
- https://github.com/openjdk/jdk21u/blob/master/src/hotspot/os/linux/attachListener_linux.cpp
- https://github.com/openjdk/jdk21u/blob/master/src/jdk.attach/share/classes/sun/tools/attach/HotSpotVirtualMachine.java
