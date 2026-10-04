# 纸质展品光照额度管理（Light Quota）

面向纸本、拓本等光敏展品的**年度照度时数（剂量，单位 lx·h）额度管理** Web 应用。
Node.js（Express）+ PostgreSQL，本地账号区分两类角色：

- **保管员（conservator）**：登记展品与每年照度时数上限、批准/驳回/复核布展计划、审核计划调整申请、录入并确认实测。
- **布展员（installer）**：创建展出计划（展期、每日开灯时段、预计照度）、对已批准且未开始的计划提交/撤回调整申请、查看额度占用。

## 核心业务规则

1. **按自然年拆分剂量**：以墙上时间（默认中国标准时间 UTC+08:00，固定偏移不处理夏令时）归属年份。
   - 每日开灯时段支持多段、支持跨午夜（如 `20:00-02:00`）；计划可以跨年，剂量自动切到各自然年。
2. **时间重叠不得批准**：同一展品，两条已批准/待复核计划只要**开灯时刻区间相交**即拒绝批准
   （即使展出日期有重叠但开灯时段不相交，也允许）。
3. **批准时合计校验**：
   `已确认实测剂量` + `其他已批准/待复核计划尚未被实测覆盖部分的估算剂量` + `本计划估算剂量`，
   任一自然年超过该展品年度上限即拒绝，并在错误信息与页面中列出**超限年份、上限、各部分占用与超额量（lx·h）**。
4. **并发安全**：批准/确认事务先对展品行加 `SELECT ... FOR UPDATE` 行锁，串行化同展品的并发批准，防止超配。
5. **实测替代估算**：展后保管员在「已批准计划的开灯时段内」录入实测时段与照度，确认后该时段改按实测计量，
   原估算的对应部分自动扣除；已确认测量记录与审批记录保留（不可直接修改/删除；
   录错时由保管员走第 15 条「实测纠错」：旧记录作废保留、替代记录确认并关联）。
6. **重叠实测拒绝**：实测时段与同展品任何未作废实测时间相交即拒绝（含待确认记录）。
7. **迟到实测导致超限**：确认实测若使某展品某自然年已用剂量超限，
   该展品在**相应年度仍有估算剂量、且尚未开始**的已批准计划自动转为 **待复核（pending_review）**，
   页面展示原因；保管员复核通过时重新执行完整的重叠+额度校验。原审批与测量记录均保留。
8. **校验报错**：非法日期/时间、零时长或互相重叠的开灯时段、非正照度/上限等一律返回明确中文错误。
9. 页面按展品展示**每个自然年的上限、已占用、剩余额度**，以及逐条占用来源
   （已确认实测、各计划估算残余，含按年剂量）。
10. **计划调整申请**：布展员可对「已批准且尚未开始」的计划提交调整申请（新展期、新每日开灯时段、新预计照度）。
    - 同一计划同时只允许**一份待审申请**；撤回或被驳回/拒绝后可重新提交。
    - **待审期间原计划继续占用额度**，计划本身不变；展品详情同时展示原值与拟改值及试算结果。
    - 保管员**批准时在展品锁事务内重新核对**：计划仍已批准且未开始；该计划所有**未作废实测（含待确认）都落在新开灯窗内**；
      新窗口不与同展品其他**已批准/待复核**计划重叠；并按自然年以「新窗口未被已确认实测覆盖部分」的估算量**替换原剩余估算量**，
      任一年超年度上限即拒绝。核对通过才**原子更新计划并写审计**；驳回不改变计划。
    - 核对失败（409）会在错误信息与结构化 `details` 中指出**冲突计划、窗外实测、超额年份与各项数值**，
      申请**保持待审**，布展员可撤回后修改重提（也可在提额后由保管员直接批准原申请）。
11. **下调年度上限（预演 + 凭证提交）**：保管员下调既有自然年的照度时数上限时，可先**预演**：
    - 预演**不改任何状态**，返回一次性**预演凭证**并列出：该年**已确认实测**、各已批准/待复核计划在该年的**估算残余**、
      **预计超额量**，以及超额时**仍有该年估算残余且尚未开始的已批准计划**（下调后将转待复核）。
    - 携凭证正式提交时在同一展品锁事务内**即时重算**：若自预演以来**额度或相关占用已变化**（上限被改、实测确认/录入、
      计划批准/取消/转复核/调整生效等），返回 **409 拒绝并附带最新核算结果与新凭证**，本次不改动任何数据。
    - 沿用旧请求字段直接修改上限（`POST /limits`）时在**同一事务即时重算**，不再要求凭证。
    - 下调成功**原子更新上限**，**原审批记录与实测记录全部保留**；把本次核算列出的未开始计划**转为待复核并写明原因**；
      **已开始的计划不转状态**，剩余超额仍在额度查询/页面中如实显示。后续复核沿用既有的重叠与额度校验，
      不删除占用、不自动取消计划。
12. **成对核准调整申请**：保管员可选取**同一展品的两份待审调整申请**成对核准，用于两条已批准且未开始的计划
    **互换或协同挪动档期**（单份批准无法完成互换：一方的拟改窗必然撞上对方的当前窗口）。
    - 输入**两个不同申请编号**；若**关联同一计划、跨展品、计划已开始或申请已结案**（非待审），一律拒绝并指出原因。
    - **试算与提交口径一致**：以两份拟改开灯窗**同时替换原窗**——新窗**彼此之间**及与**其他已批准/待复核计划**
      均不得重叠；两条计划各自所有**未作废实测**（含待确认）仍须落在**各自新窗**内；按自然年以两份新窗
      **未被已确认实测覆盖部分**的估算残余**同时替换**两份旧残余，超额时列出**年份、各计划贡献与超额量**。
    - 提交在**展品锁事务内重新核对**，全部通过才**原子更新两条计划、结案两份申请并记审计**；
      任一失败则事务回滚，**两份申请仍待审、计划与额度不变**。
13. **停灯登记（blackout）**：保管员可对**已批准或待复核**计划登记**已发生**的停灯时段（原因必填）。
    - 起点须早于终点、**结束不得晚于当前时间**；时段必须**完整落在该计划开灯窗内**；
      不得与同展品**未作废实测（含待确认草稿）**或**其他停灯记录**相交。失败一次性指出全部冲突
      （409，`details.overlappingMeasurements` / `details.overlappingBlackouts`），**不保存**。
    - **停灯记录永久保留，不可修改、不可删除**；计划取消/调整后记录仍在；**布展员只读**。
    - **扣减口径全系统一致**：停灯只从所属计划**未被已确认实测覆盖**的估算时段中扣减
      （按计划预计照度 × 停灯时长，跨年按自然年拆分）；**不减已确认实测**，
      **也不释放原计划的排期占用**（计划开灯窗与计划间重叠判定不变）。
    - 展品年度占用及来源、计划批准与复核、调整试算与核准、上限下调预演均使用**同一扣减口径**
      （估算残余 = 开灯窗 − 已确认实测覆盖 − 本计划停灯）；调整/成对核准还要求**既有停灯仍落在拟改新窗内**。
    - 后续实测**录入或确认碰到停灯时段一律拒绝**。展品详情展示全部停灯记录及**各年扣减量**，
      既有查询字段保持兼容（仅附加新字段）。
14. **联合核准（整组一次批准 2~10 条待批准计划）**：布展员和保管员均可**试算**，仅保管员可**提交联合核准**。
    - 按编号选择 **2 至 10 条不同的待批准（submitted）计划**（可跨展品）；试算逐计划列出
      **展品、各自然年新增估算占用（毛估算与扣减后残余）、原占用、上限、合并后合计及该计划的冲突标记**，
      并按展品给出年度合并报告（各计划残余贡献、合计、超额量）。
    - **组内同展品计划的开灯窗须彼此不重叠**，且**分别不与其他已批准或待复核计划重叠**
      （端点相接不算重叠；不同展品的计划互不相干）。
    - 年度残余按**现有统一口径**合并：已确认实测替代估算、本计划停灯扣减，即
      估算残余 = 开灯窗 − 已确认实测覆盖 − 本计划停灯；把组内同展品各计划的年度残余并入
      **不含组内计划的当前占用**，任一自然年超过年度上限（或该年未登记上限）即冲突。
    - 提交时在涉及展品的锁事务内（跨展品按展品 id 升序加锁）**重新核对计划状态与实时占用**：
      **全部通过才一次批准整组并逐条 + 汇总记录审计**；任一失败则**整组计划与审计均不变**，
      返回 409，结构化指出涉及的**计划、年份与冲突原因**（组内重叠/外部重叠/状态已变/未登记上限/超额）。
    - 单展品成功响应与既有单条批准同构（展品详情字段位于顶层，另附 `batchApproval`）；
      跨展品成功时返回各展品最新详情。**既有单条审批与展品详情响应保持兼容。**
15. **实测纠错（conservator only）**：保管员发现**已确认实测**的时段或照度录错时，可用
    **原记录编号、替代时段、替代照度及必填原因**发起纠错。
    - **替代记录仍属原计划**：替代时段须为正时长且**完整处于该计划开灯窗内**（按计划当前展期/开灯时段
      校验，计划待复核/取消后仍可更正其历史实测）；**不得与同展品其他未作废实测（含待确认草稿）或
      停灯记录相交**（原记录自身排除）。非法时段/照度、越窗、原记录非已确认（草稿可删、已作废须对其
      替代记录纠错）返回 **400**；相交冲突返回 **409** 并在 `details` 一次性指出全部冲突实测/停灯；
      **任何失败原记录与额度均不变**。
    - 核对通过后在**展品锁事务**内：**保留旧记录并标记作废（annulled，不删改剂量字段）**、
      **确认替代记录**（直接 confirmed）、写入两者关联（`replacesMeasurementId` / `replacedById`）
      与必填纠错原因、写审计（`measurement.correct`）；随后按既有**自然年口径**重算
      **已确认实测与估算残余**（已确认实测替代估算、停灯只扣估算残余的口径不变）。
    - 若纠错使任一年度超额，**沿用现有确认实测的生效与冲突响应口径**：纠错照常生效，返回 **409** 并把
      相关年度仍有估算残余且**尚未开始的已批准计划转待复核**（原因写明由实测纠错触发）；
      **占用下降不自动恢复任何既有待复核计划**（须保管员按既有重叠+额度口径复核）。
    - 展品详情与实测列表可**追溯前后记录与原因**（仅附加字段，既有字段不变）；
      实测纠错可链式进行（始终对当前有效的已确认记录发起）。
16. **年度用光账册封存（conservator only）**：保管员可按**展品 + 已结束的自然年**封存一份用光账册。
    - 封存沿用**现有固定时区与统一剂量口径**，在展品锁事务内**原子记录**：**当年上限**、
      **已确认实测**剂量合计、**各计划**“开灯窗 − 已确认实测覆盖 − 本计划停灯”的**估算残余**合计、
      **合计**（= 实测合计 + 残余合计）及**逐项来源**（每条来源的按年剂量、时段/计划等溯源字段）。
    - **未登记当年上限、年份尚未结束或该年已封存时拒绝**；**重复提交不得覆盖旧账**（409，指明既有账册编号）。
      账册一经封存**永久不可修改/删除**（PUT/DELETE 返回 400）。
    - 封存**不冻结**任何既有流程：之后**实测纠错、计划状态/调整、上限变化仍按现有流程生效**，
      旧账始终原样保留、不可改。
    - **展品详情与账册接口可对照**：封存值与**按当前数据重算的同年值**，含**上限和合计差额**，以及
      **按来源编号对齐的逐项差额**；**已消失来源仍须列出**（封存后作废的实测、取消的计划等，当前值标空），
      封存后新增来源同样列出；**零差额明确标示**（`zeroDifference: true` / 页面「0（无差额）」）。
    - **封存与同展品占用变动并发**时，经同一展品键锁 + 行锁串行：账册只可能是变动前或变动后的
      **一致快照**，绝不混入变动前后的数据。
    - 既有查询字段与审批、实测接口**保持兼容**（展品详情仅附加 `ledgers` 字段）。
17. **计划外照明事故（conservator only）**：保管员可按展品记录**已发生的计划外照明事故**，
    填写**墙上起止时间、实际照度、必填原因**（事故无需属于任何计划）；登录用户可在展品详情查看
    事故及按年剂量。
    - **拒绝保存（指出冲突，不落库）**：起止无效（结束不晚于开始/非法日期时间）、**实际照度非正**、
      **原因缺失**、结束时刻晚于当前（只能登记已发生事故）为 **400**；事故与同展品**未作废实测
      （含待确认草稿）、停灯、其他事故**任一相交为 **409**，`details` 一次性列出
      `overlappingMeasurements` / `overlappingBlackouts` / `overlappingIncidents` 全部冲突。
    - **事故始终计入实际用光**：按现有时区跨自然年拆分，以事故**自身实际照度**全额计入年度占用
      （不依赖任何计划）。
    - **窗内替代估算、窗外单独计量、不释放排期**：事故与**已批准/待复核**计划开灯窗相交的部分，
      按事故实际照度替代该计划相应估算（该部分从计划估算残余中扣除）；**窗外部分单独计量**。
      计划之间“开灯窗是否相交”的排期判定**完全不变**（即使事故把某计划残余替代为 0，撞其开灯窗
      的新计划/调整仍按重叠拒绝）。
    - **后续操作不得与事故相交、统一口径**：后续实测录入/确认、实测纠错、停灯登记碰到事故时段
      一律拒绝；**计划审批与复核、调整与成对核准、额度下调预演、展品占用与账册当前值**全部采用
      同一口径（估算残余 = 开灯窗 − 已确认实测覆盖 − 本计划停灯 − **事故窗内部分**；
      年度占用 = 已确认实测 + **事故实际用光** + 各计划估算残余）。
    - 登记在**展品锁事务内重算**，**超额仍生效**：返回 **409** 报告超额年份/超额量，并把相关年度
      **仍有估算残余且尚未开始**的已批准计划转**待复核**（原因注明由计划外照明事故触发，
      `plan.flag_review_incident` 审计）；已开始计划不转状态，超额仍在年度表如实显示。
    - 事故**永久保留，不可修改、不可删除**（`PUT/DELETE` 返回 400）；**已封存账册不回写**，
      事故在账册对照中作为封存后新增来源（`incident:ID`）出现；既有响应字段保持兼容
      （展品详情仅附加 `incidents` / `incidentDoseYearly`，占用来源仅附加 `kind:'incident'`）。
18. **实测 CSV 批次导入（conservator only）**：保管员可将某条**已批准（或待复核）计划**的分段实测
    CSV 导入为**待确认批次**；每行含墙上起止日期时间与实际照度（3~4 列：
    `开始日期时间,结束日期时间,实际照度[,备注]`，首行表头自动识别）。
    - **预览/导入同一校验口径**：逐行按自然年拆分剂量并汇总整批剂量，返回**整批预计占用**
      （实测替代估算口径：预计合计 = 当前占用 − 被替代估算 + 本批剂量）；**预览不写库、
      导入仅保存待确认批次，均不改变额度**。
    - 各行须**正时长、正照度**且**完整落在该计划开灯窗内**；行间及与同展品**未作废实测
      （含待确认草稿）、停灯、照明事故**不得相交。有错误时 `details.rows` 列出**行号与全部原因**
      （取值/窗口类 400，纯相交类 409），**整批不保存**。
    - **确认**时在展品锁事务内按实时占用**重新校验**整批：全部有效才**原子生成已确认实测**
      （关联批次编号）并记录批次审计（`measurement_batch.confirm`）；校验失败批次
      **保持待确认且不计量**（409）；**重复确认幂等**，返回原批次结果（`confirmResult`），
      不重复生成实测。
    - 确认导致超限**仍入账**：列出超额年份与超额量，并按既有规则把相关年度**尚未开始且有
      估算残余**的已批准计划转待复核（原因注明由实测批次确认触发）。
    - 待确认批次不占额度、不参与重叠判定；批次确认生成的实测与单条实测**同口径**进入
      年度占用与封存账册对照（`sourceKey` 仍为 `measurement:ID`）；既有单条实测、年度占用与
      账册对照字段保持兼容（实测仅附加 `importBatchId`，展品详情仅附加 `measurementBatches`）。
20. **展厅驻留与共享照明（conservator only，登录可读）**：
    - **驻留（陈列关系）**：保管员以**展厅标识、展品编号、驻留起止**登记一件展品在某展厅的
      陈列关系；**未知展品、起止无效**（结束不晚于开始/非法日期时间）拒绝。**单件展品的驻留
      区间不得重叠**（端点相接不算重叠；不同展品同期驻留同一展厅允许）；展厅首次使用时按标识
      自动创建。**已被共享照明归属覆盖的驻留不得回改/删除**（409）；未覆盖者可修改（可改展厅
      与起止，展品不可改）或删除。
    - **共享照明登记**：保管员以**展厅标识、已发生的照明起止、正数实际照度、非空原因**记录一次
      展厅共享照明。**展厅不存在、起止无效、照明尚未结束（结束晚于当前）、照度非正、原因缺失**
      均拒绝（400）；**无任何展品驻留交集**同样拒绝（400，`details.noResidenceIntersection`）。
    - **按驻留归属 + 跨年拆分**：照明按与各展品**驻留区间的交集**归属各展品，再按墙上自然年拆分；
      一次照明可同时归属多件展品（各自取其驻留交集），同一件展品若有多条相邻驻留则各成归属段。
    - **窗内替代估算、窗外单独计量、不释放排期**：与已批准/待复核**计划开灯窗**相交的归属部分按
      实际照度替代该计划估算（从残余扣除），窗外部分单独计量；计划间开灯窗重叠判定**完全不变**。
    - **整次登记原子 + 冲突列尽**：与任一归属展品的**未作废实测（含待确认草稿）、停灯或已有照明
      事故**相交时，**整次登记拒绝**（409，不落库），`details.conflictsByExhibit` 按展品分组一次性
      列出全部冲突；多展品计量与超限引发的待复核变更在**同一事务原子生效**。**超限仍入账**，返回
      **各展品超额年份**（`overflows`/`overflowsByExhibit`），并把相关年度仍有估算残余且尚未开始的
      已批准计划转待复核（`plan.flag_review_shared_lighting`）；已开始计划不转。
    - **互斥对称**：后续实测录入/确认、实测纠错、停灯登记、照明事故登记、CSV 批次导入碰到共享
      照明归属时段一律拒绝。
    - **永久保留 + 账册口径**：共享照明记录永久保留、不可修改/删除（`PUT/DELETE` 返回 400）；
      **已封存账册不回写**，共享照明在账册对照中作为封存后新增来源（`sharedLighting:ID`）出现，
      账册新增 `sharedLightingTotal`（旧账按 0 处理，总额列原样）。既有响应字段保持兼容
      （展品详情仅附加 `residences` / `sharedLightings` / `sharedLightingDoseYearly`，
      占用来源仅附加 `kind:'sharedLighting'`）。仅保管员可登记；登录用户可查看。
21. **年度用光额度分级预警（conservator 设置，登录可读）**：保管员按**展品 + 自然年**设置
    **低、高两档阈值**（年度上限占比百分比，`0 < 低档 < 高档 ≤ 100`）；登录用户可查看
    当前占用、当前级别与触发历史。
    - **未登记年度上限的年份显示「无上限」且不触发**（级别恒为 `none`，占用仍如实显示）。
    - **首次设置或修改阈值都以「当时占用」重建基线**，**不补发**任何历史事件。
    - 此后**计划批准/取消/调整（含成对核准、联合核准）、年度上限变更、实测确认/纠错、
      实测批次确认、停灯登记、计划外照明事故、展厅共享照明入账**时，均在**相应展品的锁事务内、
      按现有统一剂量口径重算**：占用**向上跨过**低档/高档才各留一条事件（一次跨两级留两条，
      顺序 low → high）；**回落不写事件，再次向上跨越可重新触发**；各自然年**跨年独立判定**；
      **超上限仍显示真实占用与最高（高）级别**（占比可 >100%）。
    - 事件在**触发操作的同一事务**内写入：多展品操作（联合核准、共享照明）回滚时事件
      **一并回滚**，不留残影。
    - 保管员可把历史事件**标记已读**（单条或按展品/年/级别批量，幂等）；**已读不改变预警级别**。
    - 既有额度、审批、账册语义与字段保持兼容（展品详情仅附加 `quotaThresholds` /
      `quotaAlerts` / `quotaAlertsUnread`，列表仅附加级别计数，触发操作响应仅附加
      `quotaAlertEvents`）。审计记录 `quota_threshold.create` / `quota_threshold.update`。

22. **年度占用按受影响自然年局部重算（统一派生机制）**：年度占用不再在每次读取时全量扫描历史，
    而是维护派生表 `annual_usage`（展品 + 自然年：`used` 及实测/事故/共享照明/估算残余四个组成部分）。
    - **单一来源与舍入口径**：展品详情、审批与复核、调整/成对核准试算、联合核准、上限下调预演、
      封存账册当前值、分级预警、展品列表概况全部沿用同一统一剂量口径与 `round3` 舍入；
      派生表只是该口径按年缓存，字段、超限冲突明细（`details.overflows` 等）与审计全部保持兼容。
    - **变更事务内按年局部重算**：计划批准、取消、调整（含成对/联合核准）、实测确认、实测纠错、
      停灯登记、计划外事故、展厅共享照明、年度上限变更，都在**原有的展品/展厅锁事务**内、
      业务写入完成后只重算**本次受影响自然年**：跨年记录影响到的每个年份同步处理；
      作废或替换（实测纠错、计划调整、取消）按**旧贡献年份与新贡献年份的并集**重算，
      即先撤回旧贡献再计入新贡献；单次变更**不扫描无关年份的全部历史记录**。
    - **预警同事务**：分级预警边沿只对同一批受影响年份判定，占用结果与预警事件在同一事务
      提交或回滚；**多展品操作（联合核准、共享照明）失败时占用结果与预警事件一并回滚**。
    - **派生结果可重建**：既有数据可通过脚本或 HTTP 维护接口全量重建（见下文「派生占用重建」）；
      启动时若 `annual_usage` 为空（旧库升级首启）会自动按展品加锁重建；**重建失败会报错并中止，
      绝不返回新旧占用混杂的结果**。

## 一键启动（Docker Compose）

前置：已安装 Docker 与 Docker Compose（v2）。

```bash
cd <本项目目录>
docker compose up --build -d
```

启动后访问：

- **应用地址：http://localhost:3000**
- PostgreSQL 仅映射到本机：`localhost:5432`（排查用，可在 compose 中删除 ports 段）

首次启动会自动：建表 → 创建两个默认账号 → 写入一个演示展品与一条跨年已批准计划（可用 `SEED_DEMO=false` 关闭）。

默认账号（**请在生产环境修改**）：

| 角色 | 用户名 | 密码 |
| --- | --- | --- |
| 保管员 | `custodian` | `guard123` |
| 布展员 | `installer` | `setup123` |

停止与清理：

```bash
docker compose down          # 停止（保留数据卷）
docker compose down -v       # 停止并删除数据库数据卷（完全重置）
docker compose logs -f app   # 查看应用日志
```

## 配置（环境变量）

可在项目根目录放 `.env`（参考 `.env.example`），或 `docker compose up` 前在 shell 中导出：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 宿主机映射端口（容器内固定 3000） |
| `DB_PORT` | `5432` | PostgreSQL 映射到宿主机的端口 |
| `PGHOST` | `db` | 数据库主机（Compose 内置网络中的服务名） |
| `PGPORT` | `5432` | 数据库端口 |
| `PGDATABASE` | `lightquota` | 数据库名 |
| `PGUSER` | `lightquota` | 数据库用户 |
| `PGPASSWORD` | `lightquota_secret` | 数据库密码 |
| `TZ_OFFSET_MINUTES` | `480` | 墙上时间相对 UTC 的固定偏移（分钟），中国为 480 |
| `SEED_CONSERVATOR_USERNAME` / `SEED_CONSERVATOR_PASSWORD` | `custodian` / `guard123` | 初始保管员账号（仅首次初始化时创建） |
| `SEED_INSTALLER_USERNAME` / `SEED_INSTALLER_PASSWORD` | `installer` / `setup123` | 初始布展员账号 |
| `SEED_DEMO` | `true` | 是否写入演示展品/计划 |

修改账号相关变量后若库中已存在同名用户不会重复创建；需要重置初始数据可 `docker compose down -v` 后重新启动。

## 本地（非 Docker）运行

```bash
npm install
# 准备一个可访问的 PostgreSQL，然后设置 PG* 环境变量（PGHOST 默认指向 compose 的 db）
PGHOST=127.0.0.1 PGUSER=lightquota PGPASSWORD=lightquota_secret npm start
```

核心剂量算法的离线自测（不需要数据库）：

```bash
npm run test:utils
```

端到端业务流程测试（基于 pg-mem，含局部重算/跨年/回滚/重建核对）：

```bash
npm test
```

## 派生占用重建（annual_usage）

`annual_usage` 是由计划/实测/停灯/事故/共享照明/上限等源数据按统一剂量口径派生的年度占用表，
可随时从源数据全量重建（幂等）。以下三种方式等价，均按展品逐个加展品锁、在事务内
「先删旧派生行 → 按统一口径逐年写回 → 同步预警阈值最近占用/级别（不补发事件）」，
**任一展品任一年份不一致即报错回滚，绝不保留新旧占用混杂的结果**：

```bash
# 1) 命令行：重建全部展品（也可只重建指定展品 id）
npm run rebuild:usage
npm run rebuild:usage -- 3 5

# 2) Docker Compose 容器内执行
docker compose exec app node scripts/rebuild-usage.js

# 3) HTTP 维护接口（仅保管员）：全量或按展品
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/maintenance/rebuild-usage \
  -H 'Content-Type: application/json' -d '{}'
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/maintenance/rebuild-usage \
  -H 'Content-Type: application/json' -d '{"exhibitIds":[3,5]}'
```

成功响应：

```json
{
  "ok": true,
  "exhibitCount": 2,
  "yearCount": 7,
  "exhibits": [
    { "exhibitId": 3, "yearCount": 4, "years": [2024, 2025, 2026, 2027] },
    { "exhibitId": 5, "yearCount": 3, "years": [2025, 2026, 2027] }
  ]
}
```

旧库升级后首次启动时若 `annual_usage` 为空，应用会自动完成一次同样的全量重建再对外服务
（重建失败则启动中止）；日常运行中所有占用变更都只在对应展品锁事务内按受影响年份局部重算。

## 使用流程

1. 保管员登录 → 「展品与额度」登记展品，并为相关自然年登记年度上限（lx·h）。
2. 布展员登录 → 「布展计划」选择展品、填展期、每日开灯时段（每行一段 `HH:MM-HH:MM`）、预计照度后提交；
   提交时即检查与已批准计划的开灯时间重叠。
3. 保管员在展品详情中查看按年预计剂量，执行批准/驳回；超限时会列出年份与超额量。
4. 展后保管员在「实测记录」录入已批准计划内的实测时段与照度 → 确认；
   若迟到实测造成年度超限，相应未开始计划转待复核，保管员在详情页复核。
5. 计划尚未开始时，布展员可在「布展计划」对该计划点「申请调整」，改填展期/开灯时段/照度后提交；
   保管员在计划行内查看原值与拟改值对照及核对结果，选择「批准调整」或「驳回」；布展员可撤回自己的待审申请后重提。
6. 两条计划需要**互换或协同挪动档期**时，布展员分别提交调整申请后，保管员在展品详情的
   「成对核准调整申请」中选择这两份待审申请：先「成对试算」查看两份拟改窗同时替换原窗的核对结果
   （彼此/与其他计划重叠、窗外实测、按年两计划贡献与超额），再「提交成对核准」；
   任一核对不通过，两份申请都保持待审、计划不变。
7. 需要**下调**某展品某自然年上限时，保管员在展品详情填写年份与拟定上限后点「下调预演」：
   页面列出该年已确认实测、各计划估算残余、预计超额量，以及将被转待复核的未开始计划；
   确认后在预演结果中点「提交下调」。若预演后占用被他人改动，提交会被拒绝并自动展示最新预演结果。
   已开始计划不会被转状态，剩余超额继续在额度表中红色显示，待复核计划由保管员复核（沿用既有重叠/额度校验）。
8. 「操作流水」保留全部审批、调整、确认、上限下调、状态变更等记录。
9. 展期内发生临时关灯（设备检修、撤展避险等）时，保管员在展品详情「停灯记录」处选择已批准/待复核计划、
   填写已发生的起止时刻与**必填原因**后登记：系统校验起止顺序、结束不晚于当前、完整落在开灯窗内、
   不与未作废实测或其他停灯相交；通过后该时段按计划预计照度从估算中按自然年扣减（不减已确认实测、
   不释放排期）。停灯记录保留、不可改删，布展员只读；之后录入/确认碰到该时段的实测会被拒绝。
10. 一个布展场次涉及多条计划时，布展员或保管员在「布展计划」按编号勾选 **2~10 条不同的待批准计划**
    做**联合试算**：逐条查看展品与各自然年新增估算、原占用、上限、合并后合计及冲突（组内开灯窗彼此重叠、
    与其他已批准/待复核计划重叠、超额/未登记上限）；确认无误后由保管员**提交联合核准**：
    系统在锁事务内重新核对计划状态与实时占用，全部通过才一次批准整组（逐条 + 汇总留痕），
    任一失败整组计划与审计均不变，并返回涉及的计划、年份与冲突原因。
12. 自然年结束后，保管员在展品详情「年度用光账册」处填入**已结束年份**点「封存账册」：
    系统原子记录该年上限、已确认实测、各计划扣除实测覆盖与停灯后的估算残余、合计与逐项来源
    （沿用固定时区与现有剂量口径）。未登记上限、年份未结束或已封存都会被拒绝，重复提交不覆盖旧账。
    封存后实测纠错、计划状态或上限变化照常生效；详情页与接口始终对照「封存值 vs 按当前数据重算值」：
    上限与合计差额、按来源编号对齐的逐项差额、已消失来源（仍列出）、零差额明确标示。
11. 展后发现**已确认实测**的时段或照度录错时，保管员在展品详情「实测记录」或「实测记录」页对该记录点
    **「纠错」**：填替代时段、替代照度与必填原因后提交。系统校验替代时段完整处于原计划开灯窗内、
    不与同展品其他未作废实测或停灯相交；通过后旧记录保留并标记作废、替代记录直接确认并互相关联，
    按自然年重算已确认实测与估算残余。若纠错造成年度超额，纠错仍生效，相关未开始已批准计划转待复核；
    占用下降不会自动恢复待复核计划。展品详情可追溯前后记录与纠错原因。
13. 发生**计划外照明事故**（闭馆后未关灯、临时补光等）时，保管员在展品详情「计划外照明事故」处填写
    **已发生**的墙上起止时间、实际照度与必填原因后登记：系统校验起止、照度、原因，并拒绝与未作废实测
    （含草稿）、停灯、其他事故相交的时段（一次性指出全部冲突且不保存）。登记成功后事故按自然年拆分、
    以实际照度**始终计入实际用光**；与已批准/待复核计划开灯窗相交的部分替代该计划估算（窗外部分单独
    计量，不释放排期）。若因此超限，**事故仍生效**，相关年度仍有估算残余且尚未开始的已批准计划自动转
    待复核（已开始计划不转，超额红色显示）。事故永久保留、不可改删；已封存账册原样保留，事故在账册
    对照中作为封存后新增来源列出。
14. 展后有多段实测数据时，保管员用 **CSV 批次导入**：对某条已批准计划先 `POST /api/measurement-batches/preview`
    预览逐行按年剂量与整批预计占用（不写库），再 `POST /api/measurement-batches` 导入为**待确认批次**
    （不改变额度）；逐行校验失败时按行号修正 CSV 后重提（整批不保存）。确认无误后
    `POST /api/measurement-batches/:id/confirm`：系统在展品锁内按实时占用重新校验，全部有效才原子生成
    已确认实测（实测带 `importBatchId` 溯源）并记批次审计；重复确认返回原批次结果。若确认导致超限，
    批次仍入账，相关年度尚未开始且有估算残余的已批准计划自动转待复核。
15. **展厅驻留与共享照明**：保管员先在展品详情或 `POST /api/residences` 以「展厅标识 + 驻留起止」
    登记展品在各展厅的陈列关系（同展品区间不得重叠；已被共享照明覆盖的驻留不可回改）。展厅发生一次
    公共照明后，在展品详情或 `POST /api/shared-lightings` 以「展厅标识 + 已发生起止 + 实际照度 + 原因」
    登记：系统按与各展品驻留区间的交集归属、跨自然年拆分；计划开灯窗内部分按实际用光替代估算，窗外
    单独计量；与未作废实测、停灯或照明事故相交则整次拒绝并列冲突。多展品计量与超限处理原子生效，
    超限仍入账并按展品返回超额年份、把相关未开始已批准计划转待复核。登录用户可在展品详情、
    `GET /api/residences`、`GET /api/shared-lightings`、`GET /api/halls` 只读查看。
16. **分级预警**：保管员在展品详情「分级预警阈值」处按**展品 + 自然年**填写低档、高档
    （年度上限占比 %，`0 < 低 < 高 ≤ 100`）后保存：系统以**当时占用重建基线、不补发事件**。
    此后计划批准/取消/调整、上限变更、实测确认/纠错、停灯、事故、共享照明入账都会在展品锁事务内
    重算：占用**向上跨过**每档才各留一条事件，回落不写、再次向上跨越可重新触发；跨年独立；
    超上限仍显示真实占用与最高级别。登录用户可在顶部「用光预警」标签（可按展品/年份/级别/未读筛选）
    与展品详情查看当前占用、级别与触发历史；保管员可单条或批量「标记已读」（不改变级别）。
    未登记年度上限的年份显示「无上限」且不触发。

## HTTP API（含计划调整申请、成对核准、**联合核准**、年度上限下调预演、停灯登记、**计划外照明事故**、**展厅驻留与共享照明**、**实测纠错**、**年度账册封存**、**实测 CSV 批次导入**）

所有接口除 `/api/health`、`/api/auth/login` 外都需要登录会话（HttpOnly Cookie `lqsession`）。
统一错误形态：`{ "error": "中文原因", "details": { ... } }`，409 用于冲突（重叠/超额/重复申请）。

### 认证

```bash
# 登录（保存 Cookie）
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"installer","password":"setup123"}'

curl -b cookies.txt http://localhost:3000/api/auth/me
curl -b cookies.txt -X POST http://localhost:3000/api/auth/logout
```

### 既有接口（响应保持兼容，计划对象额外附加调整字段）

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `GET  /api/exhibits` | 登录 | 展品列表 + 年度额度概况 |
| `POST /api/exhibits` | 保管员 | 登记展品 |
| `GET  /api/exhibits/:id` | 登录 | 展品详情：按年额度、占用来源（含 `kind:'incident'` 事故条目与 `kind:'sharedLighting'` 共享照明归属条目）、计划（计划行内联 `pendingAdjustment`）、实测、`blackouts` 停灯记录（逐条带 `yearly`）与 `blackoutDeductionYearly` 各年扣减汇总、`incidents` 计划外照明事故（逐条带 `yearly`/`yearlyInside`/`yearlyOutside`）与 `incidentDoseYearly` 各年事故实际用光汇总、`residences` 展厅驻留（附 `covered`）、`sharedLightings` 共享照明归属（逐条带 `yearly`/`yearlyInside`/`yearlyOutside`/`allocations`）与 `sharedLightingDoseYearly` 各年共享照明用光汇总、`ledgers` 已封存年度账册（每条附封存值与当前重算对照 `comparison`）、`quotaThresholds` 分级预警阈值（附当前占用/占比/级别）、`quotaAlerts` 预警触发历史与 `quotaAlertsUnread` 未读条数 |
| `GET  /api/exhibits/:id/ledgers` | 登录 | 已封存年度账册列表；`?compare=1` 附按当前数据重算的对照差额 |
| `POST /api/exhibits/:id/ledgers` | 保管员 | **封存某已结束自然年的用光账册**（原子快照）；未登记上限/年份未结束 400，重复封存 409 不覆盖旧账 |
| `GET  /api/exhibits/:id/ledgers/:year` | 登录 | 某年封存账册 + 按当前数据重算值 + 上限/合计差额 + 按来源编号逐项差额（已消失来源仍列出，零差额标示） |
| `POST /api/exhibits/:id/quota-thresholds` | 保管员 | **设置/修改分级预警阈值**（`year`/`lowPct`/`highPct`，0 < 低 < 高 ≤ 100）；以当时占用重建基线、不补发事件；成功响应为展品详情（另附 `threshold`/`rebased`/`quotaAlertEvents`） |
| `GET  /api/quota-alerts?exhibitId=&year=&level=&unreadOnly=1&limit=&offset=` | 登录 | **预警触发事件历史**（可追溯；倒序），另返回 `unreadCount` |
| `GET  /api/quota-alerts/unread-count?exhibitId=` | 登录 | 未读事件条数（页面角标） |
| `POST /api/quota-alerts/:id/read` | 保管员 | 单条标记已读（幂等；**不改变预警级别**） |
| `POST /api/quota-alerts/read-all` | 保管员 | 批量标记已读（body 可带 `exhibitId`/`year`/`level` 过滤；返回 `updatedCount`） |
| `POST /api/exhibits/:id/limits` | 保管员 | 登记/修改某自然年上限；**若为下调，同事务即时重算并把超额年未开始计划转待复核**（成功响应仍为展品详情，另附 `overflows`/`flaggedPlans`） |
| `POST /api/exhibits/:id/limits/preview` | 保管员 | **下调预演**：不改状态，返回凭证与该年实测/各计划估算残余/预计超额/将转复核的计划 |
| `POST /api/exhibits/:id/limits/lower` | 保管员 | **携预演凭证提交下调**；占用已变化返回 409 + 最新结果与新凭证 |
| `GET  /api/plans?exhibitId=` | 登录 | 计划列表（附加 `notStarted`、`pendingAdjustment` 概要） |
| `POST /api/plans` | 布展员 | 创建计划 |
| `GET  /api/plans/:id` | 登录 | 计划详情（待审申请带 `preview` 原值/拟改值试算） |
| `POST /api/plans/batch/preview` | 登录 | **联合试算**：2~10 条不同待批准计划的整组核对，不写库（布展员/保管员均可） |
| `POST /api/plans/batch/approve` | 保管员 | **联合核准**：锁事务内重核，全部通过才一次批准整组并记审计；任一失败整组不变（409） |
| `POST /api/plans/:id/approve` | 保管员 | 批准 / 复核通过 |
| `POST /api/plans/:id/reject` | 保管员 | 驳回落计划 |
| `POST /api/plans/:id/cancel` | 登录 | 取消（布展员仅自己未批准的；保管员均可） |
| `GET/POST /api/measurements`、`POST /api/measurements/:id/confirm`、`DELETE /api/measurements/:id` | 保管员 | 实测录入/确认/删草稿 |
| `POST /api/measurements/:id/correct` | 保管员 | **实测纠错**：原记录作废保留 + 替代记录确认，按自然年重算；超额 409 并转待复核 |
| `POST /api/measurement-batches/preview`、`POST /api/measurement-batches`、`POST /api/measurement-batches/:id/confirm` | 保管员 | **实测 CSV 批次导入**：预览（不写库）/导入待确认批次/确认（锁内重核，超限仍入账转待复核，重复确认幂等） |
| `GET /api/measurement-batches`、`GET /api/measurement-batches/:id` | 登录 | 批次列表（摘要）/批次详情（含逐行按年剂量与确认结果） |
| `GET /api/blackouts?exhibitId=&planId=` | 登录 | 停灯记录列表（布展员只读），逐条附 `yearly` 按年扣减量；另返回 `blackoutDeductionByExhibit` |
| `POST /api/blackouts` | 保管员 | 登记已发生停灯时段；成功响应为展品详情（另附 `blackout`）；冲突 409 不保存 |
| `GET /api/incidents?exhibitId=&planId=` | 登录 | **计划外照明事故**列表（登录可读，`planId` 过滤与该计划当前开灯窗相交的事故），逐条附按年实际用光及窗内/窗外拆分 |
| `POST /api/incidents` | 保管员 | **登记已发生计划外照明事故**；成功（201）响应为展品详情（另附 `incident`）；事故致超限仍生效，返回 **409**（`overflows`/`flaggedPlans`/`detail`）；相交冲突 409 不保存 |
| `GET /api/halls` | 登录 | 展厅列表（附各展厅驻留条数） |
| `GET /api/residences?exhibitId=&hallCode=` | 登录 | **展厅驻留（陈列关系）**列表，逐条附 `covered`（是否已被共享照明覆盖） |
| `POST /api/residences` | 保管员 | **登记驻留**（展厅标识 + 展品 + 驻留起止；展厅首次使用自动创建）；未知展品/无效起止 400，同展品驻留区间重叠 409 |
| `PUT /api/residences/:id` | 保管员 | 修改**尚未被共享照明覆盖**的驻留（可改展厅标识与起止；已覆盖 409） |
| `DELETE /api/residences/:id` | 保管员 | 删除**尚未被共享照明覆盖**的驻留（已覆盖 409） |
| `GET /api/shared-lightings?hallCode=&exhibitId=` | 登录 | **共享照明**列表（按归属展品逐条返回，附按年实际用光、窗内/窗外拆分与归属段） |
| `POST /api/shared-lightings` | 保管员 | **登记一次展厅共享照明**；按驻留交集归属多展品、跨年拆分；冲突整次拒绝（409 `details.conflictsByExhibit`）；超限仍入账返回 **409**（各展品超额年份） |
| `GET /api/audit` | 保管员 | 操作流水（含 `blackout.create`、`incident.create`、`plan.flag_review_incident`、`residence.create`、`shared_lighting.create`、`plan.flag_review_shared_lighting`） |

### 维护接口（conservator）

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/maintenance/rebuild-usage` | 保管员 | **全量（或按展品）重建派生占用表** `annual_usage`：逐展品加锁事务，先删旧行再按统一口径逐年写回并同步预警阈值最近状态（不补发事件）；任一失败回滚并报错，不产生新旧混杂占用。body `{}` 为全部展品，`{"exhibitIds":[3,5]}` 为指定展品 |

```bash
# 保管员登录后全量重建
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/maintenance/rebuild-usage \
  -H 'Content-Type: application/json' -d '{}'
```

### 计划调整申请 `/api/adjustments`

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/adjustments` | 布展员 | 对已批准且未开始的计划提交调整申请（每计划至多一份待审） |
| `POST /api/adjustments/preview` | 布展员 | 仅试算拟改值，不写库 |
| `GET  /api/adjustments?planId=&exhibitId=&status=&preview=1` | 登录 | 申请列表/历史，带原值 |
| `GET  /api/adjustments/:id` | 登录 | 申请详情（待审带试算） |
| `POST /api/adjustments/:id/approve` | 保管员 | 批准：锁事务内重新核对，通过则原子更新计划 |
| `POST /api/adjustments/:id/reject` | 保管员 | 驳回（计划不变），body 可带 `reason` |
| `POST /api/adjustments/:id/withdraw` | 布展员本人/保管员 | 撤回待审申请，之后可重新提交 |

提交申请（`POST`）请求体：

```json
{
  "planId": 12,
  "startDate": "2030-12-31",
  "endDate": "2031-01-02",
  "periods": ["09:00-12:00", "13:00-17:00"],
  "estimatedLux": 120,
  "reason": "配合跨年活动改期（可选）"
}
```

curl 调用示例（布展员提交 → 保管员核对 → 批准/驳回/撤回）：

```bash
# 1) 布展员提交调整申请（响应里的 preview 为即时试算；申请为 pending）
curl -b cookies.txt -X POST http://localhost:3000/api/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"planId":12,"startDate":"2030-12-31","endDate":"2031-01-02",
       "periods":["09:00-12:00","13:00-17:00"],"estimatedLux":120}'

# 2) 查看申请（原值 original + 拟改值 + preview.conflicts/yearlyReport）
curl -b cookies.txt http://localhost:3000/api/adjustments/1

# 3a) 保管员批准：成功返回更新后的展品详情
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/adjustments/1/approve

# 3b) 保管员驳回（计划不变）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/adjustments/1/reject \
  -H 'Content-Type: application/json' -d '{"reason":"与邻厅计划冲突"}'

# 3c) 布展员撤回（之后可用同一 planId 重新提交）
curl -b cookies.txt -X POST http://localhost:3000/api/adjustments/1/withdraw
```

批准核对失败时返回 **409**，申请保持 `pending`，`details.conflicts` 给出全部冲突：

```json
{
  "error": "调整申请 #1 未通过核对：与同展品已批准计划「夜场」(#7) 开灯时间重叠；2031 年：上限 50000，其他占用 12000，原残余 800，拟改残余 40800，合计 52800，超额 2800 lx·h",
  "details": {
    "adjustmentId": 1,
    "conflicts": {
      "notApproved": false,
      "notStarted": false,
      "outsideMeasurements": [{ "id": 31, "status": "confirmed", "start": "2031-01-02 10:00", "end": "2031-01-02 11:00" }],
      "overlappingPlans": [{ "id": 7, "title": "夜场", "status": "approved", "startDate": "2031-01-01", "endDate": "2031-01-03" }],
      "missingLimits": [],
      "overflows": [{
        "year": 2031, "limit": 50000, "usedByOthers": 12000,
        "oldResidue": 800, "newResidue": 40800, "projected": 52800, "excess": 2800
      }]
    },
    "yearlyReport": { "2031": { "...": "每个相关年份的上限/其他占用/原残余/拟改残余/合计/超额" } }
  }
}
```

常见拒绝：越权（保管员提交、非申请人撤回）→ 403；计划非已批准/已开始/无效时段或照度 → 400；
重复待审申请 → 409（`details.existingAdjustmentId`）。

### 成对核准 `/api/adjustments/pair/*`（保管员）

同一展品两份**待审**调整申请（两条不同计划）同时生效：用于两条已批准且未开始的计划互换/协同挪动档期。

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/adjustments/pair/preview` | 保管员 | 成对试算：两份拟改窗同时替换原窗的核对结果，不写库 |
| `POST /api/adjustments/pair/approve` | 保管员 | 成对核准：锁事务内重核，全部通过才原子更新两条计划并结案两份申请 |

请求体均为：

```json
{ "adjustmentIds": [21, 22] }
```

组成性拒绝（**400**，试算与提交一致）：两个编号相同、申请不存在、**关联同一计划**、**跨展品**、
**申请已结案**（非待审）；布展员调用 → 403。

试算响应（`pairPreview`）：

```json
{
  "pairPreview": {
    "exhibitId": 3,
    "adjustments": [
      { "id": 21, "planId": 8, "startDate": "2030-04-01", "...": "拟改值",
        "original": { "title": "计划D", "startDate": "2030-03-01", "...": "原值" } },
      { "id": 22, "planId": 9, "...": "第二份申请（含 original 原值）" }
    ],
    "ok": true,
    "conflicts": {
      "notApproved": [], "notStarted": [], "outsideMeasurements": [],
      "pairOverlap": false, "overlappingPlans": [], "overflows": [], "missingLimits": []
    },
    "items": [
      { "adjustmentId": 21, "planId": 8, "title": "计划D",
        "oldResidueYearly": { "2030": 800 }, "newResidueYearly": { "2030": 800 } }
    ],
    "yearlyReport": {
      "2030": {
        "year": 2030, "limit": 5000, "usedByOthers": 800,
        "oldResidueTotal": 1600, "newResidueTotal": 1600,
        "contributions": [
          { "adjustmentId": 21, "planId": 8, "title": "计划D", "oldResidue": 800, "newResidue": 800 },
          { "adjustmentId": 22, "planId": 9, "title": "计划E", "oldResidue": 800, "newResidue": 800 }
        ],
        "projected": 2400, "remainingAfter": 2600, "excess": null
      }
    }
  }
}
```

curl 调用示例（保管员已登录，Cookie 存于 cookies-custodian.txt）：

```bash
# 1) 成对试算：两份拟改开灯窗同时替换原窗（不写库）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/adjustments/pair/preview \
  -H 'Content-Type: application/json' \
  -d '{"adjustmentIds":[21,22]}'

# 2) 提交成对核准：成功返回更新后的展品详情（另附 pairApproval 摘要）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/adjustments/pair/approve \
  -H 'Content-Type: application/json' \
  -d '{"adjustmentIds":[21,22]}'
```

核对失败返回 **409**，**两份申请都保持待审、计划与额度不变**，`details` 指明全部冲突
（`notStarted`/`notApproved` 为逐计划数组，`pairOverlap` 标记两份拟改窗彼此重叠，
`overflows[].contributions` 列出各计划按年贡献与超额量）：

```json
{
  "error": "成对核准（申请 #21 + #22）未通过核对：2030 年：上限 2000，其他占用 0，两份拟改残余合计 2400（计划 #8 贡献 1600，计划 #9 贡献 800），合计 2400，超额 400 lx·h",
  "details": {
    "adjustmentIds": [21, 22],
    "conflicts": {
      "notApproved": [], "notStarted": [], "outsideMeasurements": [],
      "pairOverlap": false, "overlappingPlans": [], "missingLimits": [],
      "overflows": [{
        "year": 2030, "limit": 2000, "usedByOthers": 0,
        "oldResidueTotal": 1600, "newResidueTotal": 2400,
        "contributions": [
          { "adjustmentId": 21, "planId": 8, "title": "计划D", "oldResidue": 800, "newResidue": 1600 },
          { "adjustmentId": 22, "planId": 9, "title": "计划E", "oldResidue": 800, "newResidue": 800 }
        ],
        "projected": 2400, "excess": 400
      }]
    },
    "items": [ "每份申请各自的原/拟改残余（按年）" ],
    "yearlyReport": { "2030": { "...": "每个相关年份的上限/其他占用/两计划旧新残余/各计划贡献/合计/超额" } }
  }
}
```

成功响应与单份批准同构（展品详情字段位于顶层），另附 `pairApproval`
（`adjustmentIds`/`planIds`/`items`/`yearlyReport`）。单份审批与既有查询接口的字段和行为不变。

### 联合核准 `/api/plans/batch/*`（布展员/保管员试算，保管员提交）

一个布展场次涉及多条计划时，按编号选择 **2 至 10 条不同的待批准计划**（`submitted`，可跨展品），
整组同时试算 / 一次批准。请求体均为：

```json
{ "planIds": [12, 13, 14] }
```

组成性拒绝（**400**，试算与提交一致）：不是数组 / 少于 2 条或多于 10 条 / 编号重复 / 编号非正整数 /
计划不存在；布展员调用提交接口 → 403（试算接口布展员可用）。

试算 `POST /api/plans/batch/preview` **不写库**，返回 `batchPreview`：

- `plans[]`：每条计划的展品、展期、开灯时段、预计照度，以及内联 `batch`：
  - `grossEstimateYearly`：各自然年**新增毛估算占用**（开灯窗 × 预计照度）；
  - `residueYearly`：按统一口径扣减后的**新增估算残余**（= 开灯窗 − 已确认实测覆盖 − 本计划停灯）；
  - `yearly`：该计划涉及每个年份的 `limit` 上限、`usedByOthers` 原占用（不含组内计划）、
    `grossEstimate` 毛估算、`addedResidue` 新增残余、`groupResidue` 组内同展品残余合计、
    `projected` 合并后合计、`remainingAfter` 剩余、`excess` 超额量、`missingLimit`；
  - `conflicts`：该计划自身的冲突标记（`notSubmitted` / `internalOverlaps` /
    `overlappingPlans` / `missingLimitYears` / `overflowYears`）。
- `exhibits[]`：按展品合并的年度报告 `yearlyReport`（上限、原占用、组内残余合计、
  各计划 `contributions` 贡献、合并后合计、剩余、超额）。
- 顶层 `ok` 与 `conflicts`：`notSubmitted` / `internalOverlaps`（组内同展品彼此重叠）/
  `overlappingPlans`（与其他已批准/待复核计划重叠）/ `missingLimits` / `overflows`。

```bash
# 1) 布展员（或保管员）整组试算：不写库
curl -b cookies.txt -X POST http://localhost:3000/api/plans/batch/preview \
  -H 'Content-Type: application/json' \
  -d '{"planIds":[12,13,14]}'

# 2) 保管员提交联合核准
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/plans/batch/approve \
  -H 'Content-Type: application/json' \
  -d '{"planIds":[12,13,14]}'
```

提交在涉及展品的锁事务内（跨展品按展品 id 升序加锁，与单条审批互斥）**重新核对计划状态与实时占用**。
单展品成功响应与单条批准同构（展品详情字段位于顶层，保持兼容），另附：

```json
{
  "exhibit": { }, "years": { }, "sources": [ ], "plans": [ ], "measurements": [ ],
  "batchApproval": {
    "planIds": [12, 13, 14],
    "exhibitIds": [3],
    "items": [
      { "planId": 12, "title": "计划A", "exhibitId": 3,
        "grossEstimateYearly": { "2030": 800 },
        "residueYearly": { "2030": 800 }, "yearly": { } }
    ],
    "exhibits": [ { "exhibitId": 3, "yearlyReport": { "2030": { } } } ]
  }
}
```

跨展品成功时无顶层展品详情字段，返回 `{ "ok": true, "batchApproval": { }, "exhibitDetails": [ …各展品详情 ] }`。
审计写入一条汇总事件 `plan.batch_approve` 与组内逐条 `plan.batch_approve_item`。

任一核对失败返回 **409**，事务回滚，**整组计划与审计均不变**，`details` 指明涉及的计划、年份与全部冲突：

```json
{
  "error": "联合核准（计划 #12、#13）未通过核对：组内计划「计划A」(#12) 与「计划B」(#13) 的开灯时间彼此重叠；展品 #3 2030 年：上限 2000，原占用 800，组内新增残余合计 1600（计划 #12 残余 800，计划 #13 残余 800），合并后合计 2400，超额 400 lx·h",
  "details": {
    "planIds": [12, 13],
    "conflicts": {
      "notSubmitted": [],
      "internalOverlaps": [{ "planId": 12, "planTitle": "计划A", "otherPlanId": 13, "otherPlanTitle": "计划B" }],
      "overlappingPlans": [],
      "missingLimits": [],
      "overflows": [{
        "exhibitId": 3, "year": 2030, "limit": 2000, "usedByOthers": 800,
        "groupResidue": 1600, "projected": 2400, "excess": 400,
        "contributions": [
          { "planId": 12, "title": "计划A", "residue": 800 },
          { "planId": 13, "title": "计划B", "residue": 800 }
        ]
      }]
    },
    "items": [ "每条计划的毛估算/残余按年" ],
    "exhibits": [ "每件展品的年度合并报告" ]
  }
}
```

核对口径与单条批准完全一致：已确认实测替代估算、本计划停灯从估算残余扣减（不减实测、不释放排期）；
试算后若计划被单条批准/驳回/取消、额度调整、实测确认、新增占用等，提交会按最新状态/实时占用重新拒绝。

### 下调年度上限 `/api/exhibits/:id/limits/preview`、`/lower`

保管员下调**已登记**年度上限前先预演（拟定上限必须为正数且**低于现行上限**，否则 400）。
预演不写库，返回一次性、10 分钟有效的凭证（`token`）：

```bash
# 1) 预演：返回 token 与核算明细
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/exhibits/1/limits/preview \
  -H 'Content-Type: application/json' \
  -d '{"year":2032,"limitLxh":800}'
```

响应（`preview`）：

```json
{
  "year": 2032,
  "currentLimit": 10000,
  "proposedLimit": 800,
  "used": 1600,
  "remaining": -800,
  "excess": 800,
  "over": true,
  "confirmedMeasurements": [],
  "planResidues": [
    { "id": 7, "title": "未来计划1", "status": "approved", "startDate": "2032-06-01",
      "endDate": "2032-06-01", "periods": ["09:00-17:00"], "lux": 100,
      "yearResidue": 800, "firstStart": "2032-06-01 09:00", "notStarted": true }
  ],
  "flagCandidates": [ { "id": 7, "title": "未来计划1", "yearResidue": 800, "notStarted": true } ],
  "startedResiduePlans": [],
  "token": "b93e982e4ac7…",
  "tokenExpiresInSeconds": 600
}
```

```bash
# 2) 携凭证提交（字段须与预演一致；token 一次性）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/exhibits/1/limits/lower \
  -H 'Content-Type: application/json' \
  -d '{"year":2032,"limitLxh":800,"token":"b93e982e4ac7…"}'
```

成功响应即**展品详情**（与 `GET /api/exhibits/:id` 同构，保持兼容），并额外附带：

```json
{
  "exhibit": { }, "years": { }, "sources": [ ], "plans": [ ], "measurements": [ ],
  "year": 2032,
  "previousLimit": 10000,
  "newLimit": 800,
  "overflows": [{ "year": 2032, "limit": 800, "previousLimit": 10000,
                  "projected": 1600, "excess": 800 }],
  "flaggedPlans": [
    { "id": 7, "title": "未来计划1", "firstStart": "2032-06-01 09:00",
      "yearResidue": 800, "overflowYears": [2032] }
  ]
}
```

被转待复核的计划会写入中文原因（如“2032 年照度时数上限下调（10000 → 800 lx·h）后预计超额 800 lx·h，
本计划该年估算残余 800 lx·h，转待复核”），`approved_by/approved_at` 与实测记录原样保留。
若预演后额度或相关占用被改动，提交返回 **409**，且 `details.preview` 为**最新核算结果（含新 token）**：

```json
{
  "error": "自预演以来 2032 年额度或相关占用已变化，本次下调未执行；请按最新核算结果确认后重新提交",
  "details": {
    "preview": { "year": 2032, "currentLimit": 100000, "used": 3200, "excess": 1200,
                 "token": "新凭证…", "confirmedMeasurements": [ ] }
  }
}
```

沿用旧接口 `POST /api/exhibits/:id/limits` 直接下调时**不需要凭证**：在同一事务即时重算，
成功响应仍是展品详情（兼容），另附 `overflows` 与 `flaggedPlans`；不超额/上调/首次登记时两者为空、
`limitLowered` 为 `null`。

### 停灯登记 `/api/blackouts`

保管员对**已批准或待复核**计划登记**已发生**的停灯时段（`reason` 必填）。布展员仅有只读权限；
记录一经保存**不可修改/删除**（`PUT/DELETE /api/blackouts/:id` 返回 400）。

登记校验：起点早于终点、结束不晚于当前时间、完整落在计划开灯窗内；不与同展品未作废实测
（含待确认草稿）或其他停灯记录相交。时间/窗口/原因为 400；相交冲突为 **409**，一次性指出全部冲突且不保存。

请求体（起止可跨日，墙上时间，与实测接口同形）：

```json
{
  "planId": 7,
  "startDate": "2032-06-01",
  "startTime": "10:00",
  "endDate": "2032-06-01",
  "endTime": "12:00",
  "reason": "灯具故障临时关灯检修"
}
```

curl 示例（保管员 Cookie 存于 cookies-custodian.txt）：

```bash
# 1) 保管员登记停灯（成功响应 = 更新后的展品详情，另附本次 blackout）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/blackouts \
  -H 'Content-Type: application/json' \
  -d '{"planId":7,"startDate":"2032-06-01","startTime":"10:00",
       "endDate":"2032-06-01","endTime":"12:00","reason":"灯具故障临时关灯检修"}'

# 2) 布展员（或保管员）只读查询停灯记录及各年扣减量
curl -b cookies.txt 'http://localhost:3000/api/blackouts?exhibitId=3'
curl -b cookies.txt 'http://localhost:3000/api/blackouts?planId=7'

# 3) 布展员登记 -> 403；修改/删除 -> 400（停灯记录保留）
curl -b cookies.txt -X DELETE http://localhost:3000/api/blackouts/1
# {"error":"停灯记录保留，不可删除"}
```

成功响应中的停灯对象（展品详情顶层 `blackouts` 为全部记录、`blackoutDeductionYearly` 为各年扣减汇总）：

```json
{
  "id": 1,
  "planId": 7,
  "exhibitId": 3,
  "planTitle": "未来计划1",
  "planStatus": "approved",
  "start": "2032-06-01 10:00",
  "end": "2032-06-01 12:00",
  "reason": "灯具故障临时关灯检修",
  "creatorName": "保管员（默认）",
  "yearly": { "2032": 200 },
  "deductionActive": true
}
```

`yearly` 是该停灯从所属计划**估算**中扣减的按年剂量（计划预计照度 × 窗内停灯时长，按自然年拆分；
已被已确认实测覆盖的部分不重复扣）。所属计划已取消/驳回时记录仍列出，`deductionActive` 为 `false`，
`yearly` 为按当前计划窗计算的名义扣减量，不计入年度占用。

登记冲突（409）响应示例：

```json
{
  "error": "停灯登记失败：与待确认实测 #31（2032-06-01 10:00 ~ 2032-06-01 11:00）相交；与停灯记录 #2（计划「夜场」，2032-06-01 11:30 ~ 2032-06-01 12:30）相交，未保存",
  "details": {
    "overlappingMeasurements": [
      { "id": 31, "planId": 7, "status": "draft", "start": "2032-06-01 10:00", "end": "2032-06-01 11:00" }
    ],
    "overlappingBlackouts": [
      { "id": 2, "planId": 7, "planTitle": "夜场", "start": "2032-06-01 11:30", "end": "2032-06-01 12:30" }
    ]
  }
}
```

后续对停灯时段录入/确认实测同样被拒（409，`details.overlappingBlackoutId`）。
调整申请/成对核准试算的 `conflicts.outsideBlackouts` 会列出落在拟改新窗之外的既有停灯。

### 计划外照明事故 `/api/incidents`（保管员登记，登录可读）

保管员按展品记录**已发生的计划外照明**（不要求属于任何计划）：墙上起止时间、实际照度、必填原因。
布展员仅有只读权限；记录一经保存**永久保留、不可修改/删除**（`PUT/DELETE /api/incidents/:id` 返回 400）。

登记校验：起点早于终点、**结束不晚于当前时间**、实际照度为正、原因必填（400）；事故不得与同展品
**未作废实测（含待确认草稿）、停灯记录、其他事故**相交（409，一次性指出全部冲突，不保存）。

事故剂量口径（全系统一致）：

- 事故按墙上自然年拆分，以**自身实际照度**始终全额计入实际用光（`yearly`）；
- 与已批准/待复核计划开灯窗相交部分（`yearlyInside`，附 `insidePlanIds`）替代相应计划估算，
  从该计划估算残余中扣除；窗外部分（`yearlyOutside`）单独计量；
- **不释放计划排期**：计划间开灯窗重叠判定不变（事故把残余替代为 0 也不允许其他计划撞窗）。

请求体（起止可跨日、可跨年，墙上时间，与实测/停灯接口同形）：

```json
{
  "exhibitId": 3,
  "startDate": "2032-06-01",
  "startTime": "18:00",
  "endDate": "2032-06-02",
  "endTime": "02:00",
  "actualLux": 300,
  "reason": "闭馆后展柜照明未关闭"
}
```

curl 示例（保管员 Cookie 存于 cookies-custodian.txt）：

```bash
# 1) 保管员登记事故（成功 201：响应 = 更新后的展品详情，另附本次 incident）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/incidents \
  -H 'Content-Type: application/json' \
  -d '{"exhibitId":3,"startDate":"2024-05-10","startTime":"12:00",
       "endDate":"2024-05-10","endTime":"22:00",
       "actualLux":200,"reason":"闭馆后展柜灯未关"}'

# 2) 登录用户只读查询（按展品 / 按相交计划）
curl -b cookies.txt 'http://localhost:3000/api/incidents?exhibitId=3'
curl -b cookies.txt 'http://localhost:3000/api/incidents?planId=7'

# 3) 布展员登记 -> 403；修改/删除 -> 400（事故记录保留）
curl -b cookies.txt -X DELETE http://localhost:3000/api/incidents/1
# {"error":"计划外照明事故记录保留，不可删除"}
```

成功响应中的事故对象（展品详情顶层 `incidents` 为全部记录、`incidentDoseYearly` 为各年事故实际用光汇总）：

```json
{
  "id": 1,
  "exhibitId": 3,
  "start": "2024-05-10 12:00",
  "end": "2024-05-10 22:00",
  "actualLux": 200,
  "reason": "闭柜后展柜灯未关",
  "creatorName": "保管员（默认）",
  "yearly": { "2024": 2000 },
  "yearlyInside": { "2024": 1000 },
  "yearlyOutside": { "2024": 1000 },
  "insidePlanIds": [7]
}
```

`yearly` 为事故实际用光按年剂量（始终全额）；`yearlyInside` 是与当前已批准/待复核计划开灯窗相交
部分（替代计划估算），`yearlyOutside` 是窗外部分（单独计量）；计划取消后相交划分按当前占用计划
重算，`yearly` 不变。

相交冲突（409，**不保存**）一次性指出全部冲突：

```json
{
  "error": "计划外照明事故登记失败：与待确认实测 #31（2024-05-10 09:00 ~ 2024-05-10 10:00）相交；与停灯记录 #2（计划「夜场」，2024-05-10 10:00 ~ 2024-05-10 11:00）相交；与其他计划外照明事故 #1（2024-05-10 12:30 ~ 2024-05-10 13:30）相交，未保存",
  "details": {
    "overlappingMeasurements": [
      { "id": 31, "planId": 7, "status": "draft", "start": "2024-05-10 09:00", "end": "2024-05-10 10:00" }
    ],
    "overlappingBlackouts": [
      { "id": 2, "planId": 7, "planTitle": "夜场", "start": "2024-05-10 10:00", "end": "2024-05-10 11:00" }
    ],
    "overlappingIncidents": [
      { "id": 1, "start": "2024-05-10 12:30", "end": "2024-05-10 13:30" }
    ]
  }
}
```

登记造成年度超额时（**事故仍已生效**，与确认实测同口径返回 409 并转待复核）：

```json
{
  "message": "计划外照明事故 #5 已登记并计入实际用光，但登记后超限：2026 年超出 1000 lx·h。已将 1 条尚未开始的计划转为待复核",
  "overflows": [{ "year": 2026, "limit": 1000, "projected": 2000, "excess": 1000 }],
  "flaggedPlans": [
    { "id": 9, "title": "未开始计划", "firstStart": "2026-12-20 09:00", "overflowYears": [2026] }
  ],
  "incident": { "id": 5, "yearly": { "2026": 1200 } },
  "detail": { }
}
```

后续实测录入/确认、实测纠错、停灯登记碰到事故时段一律 409（实测确认 `details.overlappingIncidentId`，
录入/纠错/停灯登记 `details.overlappingIncidents`）。审计写入 `incident.create`（target 为事故编号，
detail 含时段/照度/原因/按年剂量）与转复核事件 `plan.flag_review_incident`。

后续实测录入/确认、实测纠错、停灯登记碰到事故时段一律 409（实测确认 `details.overlappingIncidentId`，
录入/纠错/停灯登记 `details.overlappingIncidents`）。审计写入 `incident.create`（target 为事故编号，
detail 含时段/照度/原因/按年剂量）与转复核事件 `plan.flag_review_incident`。

### 展厅驻留与共享照明 `/api/residences`、`/api/shared-lightings`、`/api/halls`（保管员登记，登录可读）

**驻留（陈列关系）**：保管员以「展厅标识 + 展品编号 + 驻留起止」登记。开始时刻缺省为开始日 `00:00`；
结束时刻缺省为**结束日次日 00:00**（即结束日整天，左闭右开）。单件展品驻留区间不得重叠；展厅首次使用
自动创建。登录用户可只读查询；布展员登记 → 403。

```bash
# 1) 保管员登记驻留（展厅 H1，2024-05-01 全天 ~ 2024-05-31 全天）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/residences \
  -H 'Content-Type: application/json' \
  -d '{"exhibitId":3,"hallCode":"H1",
       "startDate":"2024-05-01","endDate":"2024-05-31"}'

# 也可显式给出时刻
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/residences \
  -H 'Content-Type: application/json' \
  -d '{"exhibitId":3,"hallCode":"H1",
       "startDate":"2024-05-01","startTime":"09:00",
       "endDate":"2024-05-31","endTime":"18:00"}'

# 2) 只读查询（任意登录用户）：按展品 / 按展厅；展厅列表
curl -b cookies.txt 'http://localhost:3000/api/residences?exhibitId=3'
curl -b cookies.txt 'http://localhost:3000/api/residences?hallCode=H1'
curl -b cookies.txt http://localhost:3000/api/halls

# 3) 修改 / 删除：仅尚未被共享照明覆盖的驻留（已覆盖 → 409）
curl -b cookies-custodian.txt -X PUT http://localhost:3000/api/residences/12 \
  -H 'Content-Type: application/json' \
  -d '{"hallCode":"H2","startDate":"2024-05-01","endDate":"2024-06-05"}'
curl -b cookies-custodian.txt -X DELETE http://localhost:3000/api/residences/12
```

驻留对象字段：`id` / `exhibitId` / `hallId` / `hallCode` / `start` / `end` / `covered`
（`covered:true` 表示已被共享照明归属覆盖、不可回改）。

**共享照明**：保管员以「展厅标识 + **已发生**的照明起止 + 正数实际照度 + 必填原因」登记一次展厅
共享照明。照明按与各展品驻留区间的交集归属、跨自然年拆分；只能登记**结束不晚于当前**的照明。

```bash
# 登记一次展厅共享照明（起止可跨日、可跨年；时刻缺省同驻留口径）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/shared-lightings \
  -H 'Content-Type: application/json' \
  -d '{"hallCode":"H1",
       "startDate":"2024-05-10","startTime":"10:00",
       "endDate":"2024-05-10","endTime":"12:00",
       "actualLux":200,"reason":"展厅公共照明回路连续开启"}'

# 只读查询：按展厅 / 按归属展品
curl -b cookies.txt 'http://localhost:3000/api/shared-lightings?hallCode=H1'
curl -b cookies.txt 'http://localhost:3000/api/shared-lightings?exhibitId=3'

# 共享照明永久保留，不可修改/删除
curl -b cookies-custodian.txt -X DELETE http://localhost:3000/api/shared-lightings/1
# {"error":"共享照明记录保留，不可删除"}
```

计量口径与事故同构：归属展品的返回对象附

- `yearly`：归属本展品的实际用光按年剂量（始终按共享照明实际照度全额）；
- `yearlyInside` / `yearlyOutside`：与当前已批准/待复核计划开灯窗相交部分（替代计划估算）/
  窗外部分（单独计量）；`insidePlanIds` 相交到的计划；
- `allocations`：各驻留归属段（`residenceId`、起止、按年剂量）。

归属冲突（409，**整次不保存**）按展品分组一次性列出：

```json
{
  "error": "共享照明登记失败：展品 #3：与待确认实测 #31（…）相交；展品 #4：与停灯记录 #2（…）相交，整次登记未保存",
  "details": {
    "conflictsByExhibit": {
      "3": {
        "exhibitId": 3,
        "overlappingMeasurements": [ { "id": 31, "status": "draft", "start": "…", "end": "…" } ],
        "overlappingBlackouts": [],
        "overlappingIncidents": []
      },
      "4": {
        "exhibitId": 4,
        "overlappingMeasurements": [],
        "overlappingBlackouts": [ { "id": 2, "planId": 9, "planTitle": "…", "start": "…", "end": "…" } ],
        "overlappingIncidents": []
      }
    }
  }
}
```

无驻留交集（400）：`{"error":"…与该展厅任何展品的驻留区间都没有交集…",
"details":{"noResidenceIntersection":true}}`；展厅不存在/照明尚未结束/照度非正/原因缺失同为 **400**。

**多展品登记 + 超限仍入账**：一次照明归属多件展品时，在「展厅锁 → 各展品锁（按 id 升序）」的同一
事务内原子写入归属、逐展品重算并处理超限。成功（201）返回 `sharedLighting`（按展品的归属数组）、
`exhibitIds`、`exhibitDetails`；仅归属一件展品时与事故接口同构（展品详情字段位于顶层）。任一展品
超限则整体已入账并返回 **409**，`overflows` 为跨展品展开的超额年份、`overflowsByExhibit` 按展品分组、
`flaggedPlans` 为各展品被转待复核的计划：

```json
{
  "message": "共享照明 #7 已登记并按驻留归属计入实际用光，但登记后超限：展品 #3：2025 年超出 100 lx·h。已将 1 条尚未开始的计划转为待复核",
  "sharedLightingId": 7,
  "overflows": [ { "exhibitId": 3, "year": 2025, "limit": 1000, "projected": 1100, "excess": 100 } ],
  "overflowsByExhibit": [ { "exhibitId": 3, "overflows": [ ] } ],
  "flaggedPlans": [ { "exhibitId": 3, "id": 21, "title": "未开始计划", "overflowYears": [2025] } ],
  "sharedLighting": [ ],
  "exhibitDetails": [ ]
}
```

审计写入 `residence.create` / `residence.update` / `residence.delete` / `hall.create` /
`shared_lighting.create`（target 为共享照明编号，detail 含展厅/时段/照度/原因/各展品归属段与按年剂量）
及转复核事件 `plan.flag_review_shared_lighting`。账册封存的逐项来源新增
`kind='sharedLighting'`（`sourceKey="sharedLighting:ID"`），合计新增 `sharedLightingTotal`
（事故/共享照明功能上线前封存的旧账该列按 0 处理，总额列保持原样）。

### 实测纠错 `/api/measurements/:id/correct`（保管员）

保管员发现**已确认实测**的时段或照度录错时，用**原记录编号**（路径 `:id`）、**替代时段**、
**替代照度**与**必填纠错原因**发起纠错。布展员调用 → 403。

- 替代时段与实测录入同形（墙上时间，可跨日）：`startDate/startTime/endDate/endTime`。
- 替代记录**仍属原计划**：时段须正时长且完整处于**该计划当前开灯窗**内（不校验计划状态）；
  不得与同展品**其他未作废实测（含待确认草稿）或停灯记录**相交。
- 草稿不能纠错（400，可删除重录）；已作废记录不能再次纠错（400，应对其当前有效的替代记录发起）。
- 成功（200）在展品锁事务内保留旧记录并标记 `annulled`、确认替代记录、写双向关联与原因及审计，
  并按自然年重算占用；成功响应为**展品详情**（与 `GET /api/exhibits/:id` 同构，保持兼容），另附
  `correction` 摘要。
- 若纠错使年度超额，响应为 **409**（纠错仍已生效）：`overflows` / `flaggedPlans` 与确认实测同构，
  `detail` 为最新展品详情，另附 `correction`；**占用下降不恢复既有待复核计划**。

请求体：

```json
{
  "startDate": "2032-06-01",
  "startTime": "09:00",
  "endDate": "2032-06-01",
  "endTime": "13:00",
  "actualLux": 150,
  "reason": "照度计读数与结束时刻均录错"
}
```

curl 调用示例（保管员 Cookie 存于 cookies-custodian.txt）：

```bash
# 对已确认实测 #31 发起纠错（成功 200：原记录作废保留，替代记录直接确认）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/measurements/31/correct \
  -H 'Content-Type: application/json' \
  -d '{"startDate":"2032-06-01","startTime":"09:00",
       "endDate":"2032-06-01","endTime":"13:00",
       "actualLux":150,"reason":"照度计读数与结束时刻均录错"}'
```

成功响应（展品详情字段位于顶层，另附 `correction`）：

```json
{
  "exhibit": { }, "years": { }, "sources": [ ], "plans": [ ], "measurements": [ ],
  "correction": {
    "originalMeasurementId": 31,
    "replacementMeasurementId": 32,
    "reason": "照度计读数与结束时刻均录错",
    "original":    { "id": 31, "start": "2032-06-01 09:00", "end": "2032-06-01 12:00",
                     "actualLux": 100, "yearly": { "2032": 300 } },
    "replacement": { "id": 32, "start": "2032-06-01 09:00", "end": "2032-06-01 13:00",
                     "actualLux": 150, "yearly": { "2032": 600 } }
  }
}
```

展品详情 / 实测列表中每条实测**仅附加**以下追溯字段（无纠错时为 `null`，既有消费者不受影响）：

```json
{
  "id": 31, "status": "annulled",
  "replacesMeasurementId": null,
  "replacedById": 32,
  "correctionReason": "照度计读数与结束时刻均录错",
  "annulledBy": 1, "annulledAt": "2032-06-02T01:23:45.000Z"
}
```
```json
{
  "id": 32, "status": "confirmed",
  "replacesMeasurementId": 31,
  "replacedById": null,
  "correctionReason": "照度计读数与结束时刻均录错"
}
```

非法输入（400）示例：原记录是草稿/已作废、替代时段结束不晚于开始、非正照度、替代时段越出原计划
开灯窗、缺少原因：

```json
{ "error": "替代时段 2032-06-01 08:00 ~ 2032-06-01 12:00 没有完整落在原计划 #7 的开灯窗内" }
```

相交冲突（409）一次性指出全部冲突且**不保存**（原记录与额度不变）：

```json
{
  "error": "实测纠错失败：与已确认实测 #35（2032-06-01 14:00 ~ 2032-06-01 15:00）相交；与停灯记录 #2（计划「夜场」，2032-06-01 11:30 ~ 2032-06-01 12:30）相交，未保存",
  "details": {
    "overlappingMeasurements": [
      { "id": 35, "planId": 7, "status": "confirmed",
        "start": "2032-06-01 14:00", "end": "2032-06-01 15:00" }
    ],
    "overlappingBlackouts": [
      { "id": 2, "planId": 7, "planTitle": "夜场",
        "start": "2032-06-01 11:30", "end": "2032-06-01 12:30" }
    ]
  }
}
```

纠错导致年度超额时（**纠错已生效**，与确认实测同口径返回 409 并转待复核）：

```json
{
  "message": "实测纠错已生效（#31 → #32），但纠错后超限：2032 年超出 800 lx·h。已将 1 条尚未开始的计划转为待复核",
  "overflows": [{ "year": 2032, "limit": 1600, "projected": 2400, "excess": 800 }],
  "flaggedPlans": [
    { "id": 9, "title": "未来计划2", "firstStart": "2032-08-01 09:00", "overflowYears": [2032] }
  ],
  "correction": { "originalMeasurementId": 31, "replacementMeasurementId": 32 },
  "detail": { }
}
```

审计写入一条 `measurement.correct`（target 为替代记录，detail 含原/替代编号、原因、前后时段照度
与按年剂量、超额年份）；由纠错触发的计划转待复核写 `plan.flag_review`，原因中注明实测纠错。

### 实测 CSV 批次导入 `/api/measurement-batches`（保管员导入/确认，登录可读）

保管员把某条**已批准（或待复核）计划**的分段实测 CSV 导入为**待确认批次**，预览/确认后再入账。
CSV 每行 3~4 列：`开始日期时间,结束日期时间,实际照度[,备注]`；日期时间为墙上时间
`YYYY-MM-DD HH:MM`（分隔符可为空格或 `T`，秒仅允许 `:00`）；首行为表头时自动跳过
（可用 `hasHeader=true/false` 显式指定）；单批最多 5000 行。
提交方式二选一：JSON `{"planId":7,"csv":"...","sourceName":"march.csv"}`，
或 `Content-Type: text/csv` 直接提交 CSV 原文（`planId` 走查询参数）。

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/measurement-batches/preview` | 保管员 | 解析 + 逐行校验 + 整批预计占用试算，**不写库、不改变额度** |
| `POST /api/measurement-batches` | 保管员 | **导入为待确认批次**（201，附逐行按年剂量与整批预计占用）；有错误整批不保存 |
| `GET  /api/measurement-batches?exhibitId=&planId=&status=` | 登录 | 批次列表（摘要，不含逐行） |
| `GET  /api/measurement-batches/:id` | 登录 | 批次详情（含逐行按年剂量与确认结果） |
| `POST /api/measurement-batches/:id/confirm` | 保管员 | **确认**：展品锁内按实时占用重核，全部有效才原子生成已确认实测并记批次审计；重复确认返回原批次结果 |

CSV 示例（`march.csv`）：

```csv
开始时间,结束时间,实际照度,备注
2031-03-01 09:00,2031-03-01 12:00,120,上午
2031-03-01T13:00,2031-03-01T17:00,120,
2031-03-02 09:00,2031-03-02 17:00,150,次日
```

curl 调用示例（保管员 Cookie 存于 cookies-custodian.txt）：

```bash
# 1) 预览：逐行按年剂量 + 整批预计占用，不写库
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/measurement-batches/preview \
  -H 'Content-Type: application/json' \
  -d '{"planId":7,"csv":"2031-03-01 09:00,2031-03-01 12:00,120\n2031-03-01 13:00,2031-03-01 17:00,120\n"}'

# 也可以直接提交 CSV 原文（planId 走查询参数）
curl -b cookies-custodian.txt -X POST \
  'http://localhost:3000/api/measurement-batches/preview?planId=7' \
  -H 'Content-Type: text/csv' --data-binary @march.csv

# 2) 导入为待确认批次（不改变额度；有错误整批不保存）
curl -b cookies-custodian.txt -X POST 'http://localhost:3000/api/measurement-batches?planId=7' \
  -H 'Content-Type: text/csv' --data-binary @march.csv

# 3) 列表 / 详情（布展员只读）
curl -b cookies.txt 'http://localhost:3000/api/measurement-batches?exhibitId=3&status=pending'
curl -b cookies.txt http://localhost:3000/api/measurement-batches/1

# 4) 确认：锁内重核后原子生成已确认实测（重复调用返回原批次结果）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/measurement-batches/1/confirm
```

预览响应（`preview`）：逐行 `rows[].yearly`（按自然年剂量）、整批 `totalYearly`，以及
**整批预计占用** `projectedYears`（实测替代估算口径：`projected = usedBefore − replacedEstimate + batchDose`）：

```json
{
  "preview": {
    "planId": 7, "exhibitId": 3, "planTitle": "春季特展",
    "rowCount": 3, "headerDetected": true,
    "rows": [
      { "row": 1, "line": 2, "start": "2031-03-01 09:00", "end": "2031-03-01 12:00",
        "actualLux": 120, "note": "上午", "yearly": { "2031": 360 } }
    ],
    "totalYearly": { "2031": 2040 },
    "projectedYears": {
      "2031": { "year": 2031, "limit": 10000, "usedBefore": 1600, "batchDose": 2040,
                "replacedEstimate": 1500, "projected": 2140,
                "remainingAfter": 7860, "over": false, "missingLimit": false }
    }
  }
}
```

导入成功（201）返回 `{ batch, projectedYears, headerDetected }`；批次为 `pending`，
**不改变额度**（展品详情 `measurementBatches` 可见摘要，实测列表不变）。
行级校验失败时 `details.rows` 列出**行号与全部原因**（取值/窗口类 400，纯相交类 409），**整批不保存**：

```json
{
  "error": "实测 CSV 校验失败，整批未保存：第 1 行：时段 2031-03-01 08:00 ~ 2031-03-01 10:00 没有完整落在计划 #7 的开灯窗内；第 6 行：与第 5 行（2031-03-01 10:00 ~ 2031-03-01 11:00）时段相交",
  "details": {
    "rows": [
      { "row": 1, "line": 1, "kinds": ["window"],
        "reasons": ["时段 2031-03-01 08:00 ~ 2031-03-01 10:00 没有完整落在计划 #7 的开灯窗内"],
        "conflicts": {} },
      { "row": 6, "line": 6, "kinds": ["overlap"],
        "reasons": ["与第 5 行（2031-03-01 10:00 ~ 2031-03-01 11:00）时段相交"],
        "conflicts": { "overlappingRows": [5] } }
    ]
  }
}
```

确认成功（200）返回 `{ batch, confirmResult, detail }`：`confirmResult.measurementIds` 为原子生成的
已确认实测编号（实测带 `importBatchId` 溯源，与单条实测同口径进入年度占用与封存账册对照）。
**重复确认**返回 `{ duplicate: true, batch, confirmResult, detail }`（原批次结果，不重复生成）。
确认时若实时状态已变（计划被取消、新增重叠实测/停灯/事故），返回 **409** 且
`details.rows` 指出失败行，**批次保持待确认且不计量**；确认导致超限**仍入账**，返回 **409**
（`overflows`/`flaggedPlans`/`batch`/`detail`），相关年度尚未开始且有估算残余的已批准计划转待复核。
审计写入 `measurement_batch.import` 与 `measurement_batch.confirm`（target 为批次编号）。

### 年度用光账册封存 `/api/exhibits/:id/ledgers`（保管员封存，登录可读）

保管员可按**展品 + 已结束自然年**封存一份**不可变**用光账册。封存沿用现有固定时区与统一剂量口径，
在同一展品锁事务内**原子记录**：

- `limit`：该年年度上限（封存时必须已登记，否则 400）；
- `confirmedTotal`：该年**已确认实测**剂量合计（停灯不减实测）；
- `incidentTotal`：该年**计划外照明事故**实际用光合计（事故始终按自身实际照度全额计入）；
  事故功能上线前封存的旧账无此字段，读取时按 0 处理，总额列保持原样；
- `residueTotal`：各**已批准/待复核**计划在该年的**估算残余**合计
  （= 开灯窗 − 已确认实测覆盖 − 本计划停灯 − **事故窗内部分**，按计划预计照度计）；
- `total`：合计 = `confirmedTotal + incidentTotal + residueTotal`；
- `items`：**逐项来源**，`kind=measurement`（实测，含时段/照度/计划编号）、`kind=incident`
  （计划外照明事故，含时段/实际照度/原因/窗内窗外拆分）或 `kind=plan`
  （计划估算残余，含名称/状态/展期/开灯时段/照度），每条带该年 `yearDose` 与稳定 `sourceKey`
  （`measurement:ID` / `incident:ID` / `plan:ID`，供逐项差额对齐）。

拒绝规则：布展员封存 → 403；年份非法/缺省 → 400；**该年未登记上限** → 400；
**年份尚未结束**（墙上当前年份或未来年）→ 400；**该年已封存** → **409**（`details.existingLedgerId`），
重复提交**不覆盖旧账**；`PUT/DELETE` 账册 → 400（旧账永久保留、不可改删）。

```bash
# 1) 保管员封存某已结束自然年（201 Created；响应含封存账册，comparison 为封存瞬间全零差额对照）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/exhibits/3/ledgers \
  -H 'Content-Type: application/json' -d '{"year":2024}'

# 2) 登录用户列出某展品全部已封存账册（?compare=1 附按当前数据重算的对照差额）
curl -b cookies.txt 'http://localhost:3000/api/exhibits/3/ledgers?compare=1'

# 3) 取某年封存账册 + 当前重算值 + 合计/逐项差额
curl -b cookies.txt http://localhost:3000/api/exhibits/3/ledgers/2024
```

封存成功响应（`ledger`）：

```json
{
  "id": 1, "exhibitId": 3, "year": 2024,
  "limit": 100000, "confirmedTotal": 450, "residueTotal": 800, "total": 1250,
  "items": [
    { "sourceKey": "measurement:31", "kind": "measurement", "id": 31,
      "label": "实测 #31（计划 #7）", "planId": 7,
      "start": "2024-05-01 09:00", "end": "2024-05-01 12:00", "lux": 150, "yearDose": 450 },
    { "sourceKey": "plan:7", "kind": "plan", "id": 7,
      "label": "估算残余 · 计划 #7「春季特展」", "title": "春季特展", "status": "approved",
      "startDate": "2024-05-01", "endDate": "2024-05-01",
      "periods": ["09:00-17:00"], "lux": 100, "yearDose": 500 },
    { "sourceKey": "plan:8", "kind": "plan", "id": 8, "yearDose": 300 }
  ],
  "sealedBy": 1, "sealedByName": "保管员（默认）",
  "sealedAt": "2025-01-05T02:10:00.000Z", "sealedAtWall": "2025-01-05 10:10",
  "tzOffsetMinutes": 480
}
```

`GET …/ledgers/:year` 的对照部分（封存之后实测纠错、计划取消、上限变化都可能改变当前值；
封存值始终原样保留）：

```json
{
  "ledger": { "id": 1, "year": 2024, "limit": 100000, "confirmedTotal": 450,
               "residueTotal": 800, "total": 1250, "items": [ ] },
  "current": { "year": 2024, "limit": 90000, "confirmedTotal": 800,
               "residueTotal": 400, "total": 1200, "items": [ ] },
  "comparison": {
    "year": 2024,
    "totals": {
      "limit":          { "sealedDose": 100000, "currentDose": 90000, "delta": -10000, "zeroDifference": false },
      "confirmedTotal": { "sealedDose": 450, "currentDose": 800, "delta": 350, "zeroDifference": false },
      "residueTotal":   { "sealedDose": 800, "currentDose": 400, "delta": -400, "zeroDifference": false },
      "total":          { "sealedDose": 1250, "currentDose": 1200, "delta": -50, "zeroDifference": false }
    },
    "itemDiffs": [
      { "sourceKey": "measurement:31", "kind": "measurement", "id": 31,
        "sealed": true, "present": false, "sealedDose": 450, "currentDose": null,
        "delta": -450, "zeroDifference": false },
      { "sourceKey": "measurement:32", "kind": "measurement", "id": 32,
        "sealed": false, "present": true, "sealedDose": null, "currentDose": 800,
        "delta": 800, "zeroDifference": false },
      { "sourceKey": "plan:7", "kind": "plan", "id": 7,
        "sealed": true, "present": true, "sealedDose": 500, "currentDose": 400,
        "delta": -100, "zeroDifference": false },
      { "sourceKey": "plan:8", "kind": "plan", "id": 8,
        "sealed": true, "present": false, "sealedDose": 300, "currentDose": null,
        "delta": -300, "zeroDifference": false }
    ]
  }
}
```

差额字段一律为“当前 − 封存”。`present=false` 表示**已消失来源**（封存后作废的实测、取消/驳回而退出
占用的计划），仍列出且 `currentDose=null`；`sealed=false` 表示封存后新增来源；
**零差额逐项 `zeroDifference: true` 且 `delta: 0`**，封存瞬间的对照所有字段/逐项均为零差额。
展品详情（`GET /api/exhibits/:id`）的每条 `ledgers[]` 内嵌同样的 `comparison`，**既有字段不变**。
封存与同展品的批准、确认、纠错、调整等经同一展品键锁 + 行锁串行，账册不会混入变动前后两截数据。
审计写入一条 `ledger.seal`（target 为账册编号，detail 含年份、上限、各合计与来源条数）。

### 年度用光分级预警 `/api/exhibits/:id/quota-thresholds`、`/api/quota-alerts`（保管员设置，登录可读）

保管员按**展品 + 自然年**设置低、高两档阈值（年度上限占比百分比，`0 < 低档 < 高档 ≤ 100`）。
首次设置或修改都以**当时占用重建基线**、**不补发事件**；此后各类占用/上限变动在对应展品锁事务内
按统一剂量口径重算，只有占用**向上跨过**某档才各留一条事件，回落不写、再次向上跨越可重触发；
跨年各自然年独立；超上限仍显示真实占用与最高级别；多展品操作回滚时事件一并回滚。
登录用户可在页面「用光预警」标签与展品详情查看；保管员可标记已读（不改变级别）。

```bash
# 1) 保管员设置（或修改）某展品某年的低/高档阈值（重建基线，不补发事件）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/exhibits/3/quota-thresholds \
  -H 'Content-Type: application/json' \
  -d '{"year":2026,"lowPct":60,"highPct":90}'

# 2) 登录用户查询展品详情：quotaThresholds（当前占用/占比/级别）+ quotaAlerts（触发历史）
curl -b cookies.txt http://localhost:3000/api/exhibits/3

# 3) 全局/按条件查询预警事件历史（登录可读；可按展品/年份/级别/仅未读过滤）
curl -b cookies.txt 'http://localhost:3000/api/quota-alerts?exhibitId=3&unreadOnly=1'
curl -b cookies.txt 'http://localhost:3000/api/quota-alerts?year=2026&level=high'
curl -b cookies.txt http://localhost:3000/api/quota-alerts/unread-count

# 4) 保管员标记已读（不改变预警级别；幂等）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/quota-alerts/12/read
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/quota-alerts/read-all \
  -H 'Content-Type: application/json' -d '{"exhibitId":3}'
```

非法阈值（非数字、`低档 ≤ 0`、`高档 > 100`、`低档 ≥ 高档`、年份越界）→ 400；
布展员设置/标记已读 → 403。

设置成功响应（展品详情字段位于顶层，另附 `threshold` 与 `rebased`）：

```json
{
  "exhibit": { }, "years": { }, "sources": [ ], "plans": [ ],
  "quotaThresholds": [
    {
      "id": 1, "exhibitId": 3, "year": 2026,
      "lowPct": 60, "highPct": 90,
      "hasLimit": true, "limit": 1000,
      "used": 0, "usedPct": 0, "level": "none",
      "baselineUsed": 0, "baselineLevel": "none"
    }
  ],
  "quotaAlerts": [],
  "quotaAlertsUnread": 0,
  "threshold": { "year": 2026, "lowPct": 60, "highPct": 90, "level": "none" },
  "rebased": { "used": 0, "level": "none", "hasLimit": true }
}
```

未登记年度上限时阈值对象为
`{ "hasLimit": false, "limit": null, "used": 600, "usedPct": null, "level": "none" }`
（页面显示「无上限」，占用仍如实显示，不触发）。

占用向上跨档时，触发操作的成功响应（或**超额仍生效**场景的 409 响应）会附本次新事件
`quotaAlertEvents`（跨两级时 low/high 各一条）；事件对象与历史接口一致：

```json
{
  "id": 7,
  "exhibitId": 3,
  "year": 2026,
  "thresholdId": 1,
  "level": "high",
  "triggerType": "plan.approve",
  "limit": 1000,
  "used": 950,
  "lowPct": 60,
  "highPct": 90,
  "usedPct": 95,
  "previousUsed": 600,
  "previousLevel": "low",
  "triggerDetail": { "planId": 12, "addedYearly": { "2026": 350 } },
  "createdBy": 1,
  "createdAt": "2026-02-10T03:14:22.000Z",
  "readBy": null,
  "readAt": null
}
```

`triggerType` 取值：`plan.approve` / `plan.reapprove` / `plan.cancel` /
`plan.adjustment.approve` / `plan.adjustment.pair_approve` / `plan.batch_approve` /
`measurement.confirm` / `measurement.correct` / `measurement_batch.confirm` /
`blackout.create` / `incident.create` / `shared_lighting.create` / `limit.change`。
超限场景占比可超过 100（如 112.5%），级别仍为 `high`，`used` 为真实占用。

历史事件列表响应：

```json
{
  "events": [
    { "id": 7, "exhibitId": 3, "year": 2026, "level": "high", "triggerType": "plan.approve",
      "used": 950, "usedPct": 95, "readAt": null }
  ],
  "unreadCount": 1
}
```

审计写入 `quota_threshold.create`（首次设置）与 `quota_threshold.update`（修改重建基线）。


```
src/
  server.js        启动入口（等待数据库、初始化、起 HTTP 服务）
  app.js           Express 应用与统一错误处理
  config.js        环境变量配置
  db.js            pg 连接池、事务封装、类型解析
  init.js          建表、初始账号、演示数据
  schema.sql       表结构
  auth.js          会话与角色中间件、bcrypt 登录校验
  audit.js         操作流水写入
  limit-preview.js 下调上限预演凭证（签发/一次性消耗/占用指纹）
  alerts.js        年度用光分级预警：阈值校验/基线重建、占用向上跨档边沿判定与事件写入、查询与已读标记
  usage.js         年度占用统一派生机制：按受影响自然年局部重算 annual_usage（撤回旧贡献→计入新贡献）、
                   同事务刷新预警边沿、全量重建（展品加锁事务，失败报错不混杂）
  validation.js    中文输入校验（时段/日期/正数等）
  csv.js           实测 CSV 批次解析（表头识别、墙上日期时间、逐行取值校验）
  dosing.js        剂量核心算法：时间窗、按年拆分、区间扣除、重叠/包含判断
  ledger.js        年度用光账册封存：按年快照构建（复用统一占用口径）、封存校验落账、封存值与当前重算的逐项/合计差额对照
  service.js       额度占用计算（支持按受影响自然年的局部重算，复用同一来源/舍入口径）、批准校验、实测窗口校验、实测纠错（旧记录作废+替代记录确认+关联）、待复核筛选、调整申请试算/核对（含成对核准）、联合核准整组试算/核对、下调上限预演核算、停灯登记校验与按年扣减、计划外照明事故登记校验/窗内替代窗外单独计量口径、展厅驻留登记/覆盖校验、共享照明按驻留交集归属/跨年拆分/多展品原子登记与冲突收集/超限处理、实测批次逐行评估（窗口/相交/行间相交）与确认超限处理
  routes/          auth/users/exhibits/plans（含联合核准 batch 接口）/adjustments/measurements（含实测纠错 correct 接口）/measurement-batches（实测 CSV 批次导入：预览/导入/确认）/blackouts/incidents（计划外照明事故）/residences（展厅与驻留登记/改删）/shared-lightings（共享照明登记与只读查询）/ledgers（年度账册封存与对照）/alerts（分级预警阈值设置、事件历史查询与已读标记）/maintenance（派生占用全量重建）/audit 路由
public/            原生 HTML/CSS/JS 单页界面
scripts/test-utils.js  核心算法离线测试
scripts/test-integration.js  基于 pg-mem 的端到端业务流程测试（含年度账册封存/对照/并发、分级预警基线/边沿触发/回落重触发/无上限/跨年/回滚/已读、占用按年局部重算/跨年并集/纠错换贡献/回滚/HTTP 与离线重建）
scripts/rebuild-usage.js  annual_usage 派生占用全量重建（npm run rebuild:usage，等价于维护接口）
Dockerfile / docker-compose.yml
```
