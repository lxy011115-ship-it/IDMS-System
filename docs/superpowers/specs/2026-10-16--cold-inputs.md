# 批内输入/有效行双流证明

延续完整方案A：将bindings-only冷证明的最大批次rows/validRows对象图改成原输入流和有效顺序流，保持原全canonical根、输入冻结摘要、完整来源及原治理/typed/更正规则。metadata/error/lineNumbers/correction.before和单个审计事件仍完整保留并计量，不宣称全元数据恒定内存；完整GET/写模型与其容量仍存在。

引入明确BatchMetadata和FrozenInputEvidence，不给BatchBody填空数组。共享快照值公式拆出不含rows的字段工厂，完整原包装仍原SHA；新按原canonical字段顺序流式写rows并计算冻结摘要。紧凑定长manifest记录有效ordinal对应的原input ordinal/位置和行SHA，第二条valid stream核对覆盖/连续顺序/原输入身份及摘要并重放validRows，允许原输入ordinal间隙和合法valid顺序。

原映射/类型/更正冻结校验共享metadata+输入证明入口，完整原API由真实BatchBody适配，按原条件惰性计算摘要/源类型引用。更正期待逐输入行登记，最后检查validRows与原输入同序等价、总数和版本规则；全部root事实/typed/版本链仍完成后才生成可用证明。需要完整视图的明确collector收集证明中的真实两流对象，成功后冻结，不在证明后重读未绑定对象。

固定manifest按count计划预留，再分配，所有输入/有效流计数、bitmap/ordinal/行SHA、原行号、profile引用及校验覆盖失败关闭；取消排空已执行语句，释放manifest/临时行，不缓存失败。原schema/历史/checksum、全写/维护/原根/MVCC/default不改，不提高额度掩盖增长。

保留上一批真实批次证明为独立参考；单位覆盖全部公式/七类型/映射继承/更正/重复错误/ordinal与选择排列、根重算治理/伪造前记录及生命周期。实际PG/OIDC含单批10000与大更正样本，当前index冷/启动/页/CSV/legacy capture、故障/取消/RR/低预算/全回归及原4010受控升级/旧SID游标/逐表/原件/前后恢复。独立快照SHA和记忆，完整目标ACTIVE。
