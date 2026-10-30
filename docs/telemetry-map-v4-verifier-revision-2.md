# 采集领域发布校验器修订2

原发布及34份源全部保留，业务代码和测试证据没有修改。首次运行原check-progress.py时，在读取旧基线报告的sqlImplementation处KeyError；该历史报告没有此字段。其余基线源及最终主QA执行源SHA均保持，不能给历史报告补造字段。

修订2对比原始基线报告与其保留输入，验证基线实际导入createLegacyV4Qa；该夹具由旧12源迁移清单固定SHA，实际导入state-map-schema-v1.mjs。因此基线SQL来源由已固定代码验证。最终主QA、ABBA、CLI及15守卫仍按各自真实报告与执行输入校验，不跳过业务断言。

当前可重复入口：

```powershell
python work/telemetry-map-v4-20261019/check-progress-r2.py
```

修订源和本说明各自双份发布，摘要见telemetry-map-v4-verifier-revision-2.json。原check-progress.py及首次失败记录不被替换或冒称成功。原guide/progress中的旧校验命令由此修订说明取代。整个站点尚未v4切换，完整商用目标继续ACTIVE。
