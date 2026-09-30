# LAN 性能基线与同步决策

第四阶段先测量正式遭遇服务的现有 Demo 链路，再决定是否引入真正的增量协议。本阶段没有修改生产同步协议，也没有引入生产 telemetry API。可重复基准位于 [`test/lan-performance.test.ts`](../test/lan-performance.test.ts)，结果由隔离 runner 写入 [`.tmp/lan-performance.json`](../.tmp/lan-performance.json)（运行时生成，不作为源码提交）。

## 测量范围

运行 `pnpm test:lan:perf` 可通过隔离 runner 复测后端基准和前端 store；两者也纳入 `pnpm verify:lan`。

基准使用 `createEncounterServer`、正式 `EncounterCoordinator`、HTTP 登录/分配角色入口和 Socket.IO WebSocket 命令入口；每个场景都有 1 个 GM 和 3 个独立玩家 socket。存储使用每场景单独创建的临时 `SqliteEncounterRepository`，结束后删除。Prisma 开发数据库没有被使用或修改。

为让 barrier 之间的时间推进可重复，测试复制 Demo RulePack 后只在测试副本中固定 `DEMO_MELEE_STRIKE`：startup=2、ACTIVE=1、recovery=2、priority=10、damage=18，且没有骰子表达式。每个 barrier 提交 3 个玩家 ACTION，GM 对所有非玩家实体提交 WAIT；玩家攻击前三个敌人。实体 HP 设置为 1,000,000，focus/poise 设置为 0，避免死亡和反应窗口改变工作负载，同时仍经过真实动作计划、事件堆、结算、日志和广播路径。

每个场景先执行 1 轮 warmup。warmup 完成后，runner 等待所有 socket 收到当前 revision，再清空事件和 ACK 计数；测量只覆盖后续 barrier。场景配置如下：

| 场景 | 实体数 | 测量 barrier | 玩家 ACTION | GM WAIT | measured source increments | `processPending(1)` 样本 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 6 | 3 | 9 | 9 | 48 | 9 |
| expanded | 24 | 3 | 9 | 63 | 102 | 9 |
| history | 6 | 10 | 30 | 30 | 160 | 30 |

`source increments` 是 Coordinator 发布的 revision 更新次数，包含命令计划/日志等导致的状态发布；它不是单纯的 Tick 数。每次 `processPending(1)` 样本包含该调用同步触发的 Coordinator/Server 广播成本，因此字段命名为 `processPendingDurationMs`，不能解读成纯 CombatEngine 运算耗时。另测 `broadcastDurationMs` 作为广播边界的分项。

## 字节和次数口径

服务端 runner 对每个 Socket.IO 事件 payload 计算：

```ts
Buffer.byteLength(JSON.stringify(value), 'utf8')
```

数值是应用 JSON 字节数，不包含 Socket.IO/Engine.IO framing、事件传输编码、WebSocket/TCP/TLS 头、压缩或实际网络带宽开销。`DEMO_INCREMENT` 的事件 JSON 包含该 socket 的 filtered snapshot 和 increment；报告还把其中的 `snapshotJsonBytes`、`incrementJsonBytes` 分开统计。命令 ACK 不计入事件总字节，ACK 的完整 JSON 和其中的 snapshot 单独统计。

socket 的 `receivedCount` 是收到 `DEMO_SNAPSHOT`/`DEMO_INCREMENT` 的次数，`acceptedByRevisionGateCount` 只是 runner 的 revision 顺序检查，不代表 Zustand 或 React store 实际应用，也不包含 ACK。浏览器 store 的真实 `setSnapshot` 观测另列在下方。

分布使用 nearest-rank p50/p95；没有把耗时写成 CI 硬阈值。当前每场景只有 9、9、30 个 `processPending(1)` 样本，p95/max 只用于方向性比较。

## 服务端结果

以下数值来自本次最新 `.tmp/lan-performance.json`，运行环境为 Node `v22.19.0`、Windows x64。事件总数和事件 JSON 字节是四个 socket 合计；ACK snapshot 字节单列，未混入事件总字节。

| 场景 | increments / ticks | `processPending` p50 / p95 / max (ms) | broadcast p50 / p95 / max (ms) | socket events | event JSON bytes | ACK snapshot JSON bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 48 / 9 | 10.0884 / 12.7167 / 12.7167 | 3.6478 / 5.0891 / 5.1374 | 192 | 2,701,106 | 251,607 |
| expanded | 102 / 9 | 24.9370 / 29.5527 / 29.5527 | 10.9301 / 12.6539 / 13.5763 | 408 | 16,799,351 | 3,245,878 |
| history | 160 / 30 | 11.7600 / 18.5520 / 24.6812 | 4.8578 / 7.7444 / 11.4572 | 640 | 12,603,022 | 1,216,823 |

expanded 将实体数从 6 增至 24 后，四 socket 的事件 JSON 总量从 2.70 MB 增至 16.80 MB，`processPending` p95 从 12.7167 ms 增至 29.5527 ms。history 保持 6 个实体但把 measured barrier 从 3 增至 10，事件 JSON 总量为 12.60 MB，说明历史和命令 ACK 也会让 payload 持续变大。这里的 MB 只是 1,000,000 字节换算，不是传输带宽测量。

每个 socket 的事件次数和总 JSON 字节如下。测量区间内四个 socket 都只收到 `DEMO_INCREMENT`；连接时的初始 `DEMO_SNAPSHOT` 已在 warmup fence 前排除。

| 场景 | socket | `DEMO_INCREMENT` 次数 | 事件总次数 | 事件 JSON 总字节 | state received / accepted / rejected |
| --- | --- | ---: | ---: | ---: | ---: |
| small | GM | 48 | 48 | 786,641 | 48 / 48 / 0 |
| small | P1 | 48 | 48 | 638,542 | 48 / 48 / 0 |
| small | P2 | 48 | 48 | 638,155 | 48 / 48 / 0 |
| small | P3 | 48 | 48 | 637,768 | 48 / 48 / 0 |
| expanded | GM | 102 | 102 | 4,778,543 | 102 / 102 / 0 |
| expanded | P1 | 102 | 102 | 4,007,323 | 102 / 102 / 0 |
| expanded | P2 | 102 | 102 | 4,006,936 | 102 / 102 / 0 |
| expanded | P3 | 102 | 102 | 4,006,549 | 102 / 102 / 0 |
| history | GM | 160 | 160 | 3,851,083 | 160 / 160 / 0 |
| history | P1 | 160 | 160 | 2,918,603 | 160 / 160 / 0 |
| history | P2 | 160 | 160 | 2,917,313 | 160 / 160 / 0 |
| history | P3 | 160 | 160 | 2,916,023 | 160 / 160 / 0 |

每个 `DEMO_INCREMENT` 的 filtered snapshot 分量在 expanded 场景达到 GM p95 55,693 bytes、玩家 p95 44,693 bytes（最大分别 56,373 和 45,079）；small 场景为 GM p95 19,726、玩家 p95 15,450 bytes（最大分别 19,941 和 15,941）。history 场景保持 6 个实体但 snapshot p95 为 GM 33,286、玩家 24,375 bytes，最大分别 35,241 和 25,775。increment 分量远小于 snapshot 分量：expanded p95 为 1,406 bytes，history 为 2,094 bytes；这说明当前事件形态的主要体积来自重复 snapshot。

ACK snapshot 仍按 socket 单列：

| 场景 | GM ACK 次数 / snapshot 字节 | P1 | P2 | P3 | 四 socket合计 |
| --- | ---: | ---: | ---: | ---: | ---: |
| small | 9 / 145,275 | 3 / 32,957 | 3 / 35,441 | 3 / 37,934 | 251,607 |
| expanded | 63 / 2,913,472 | 3 / 108,297 | 3 / 110,799 | 3 / 113,310 | 3,245,878 |
| history | 30 / 714,518 | 10 / 159,098 | 10 / 167,425 | 10 / 175,782 | 1,216,823 |

## 客户端配套观测

真实浏览器九场景链路报告为 [`.tmp/lan-browser-1789689908635/report.json`](../.tmp/lan-browser-1789689908635/report.json)，9/9 场景通过，cleanupErrors=0，开发数据库未改变。观测覆盖四个主页及重启后的新 GM 页，共五页，不包含辅助多连接 popup、HTTP、roster 和其他消息。该报告的 browser packet 口径是解码后的 Socket.IO JSON packet array（包含事件名），同样排除协议 framing，与上面 payload-only 的口径不同。

| browser 角色 | `DEMO_INCREMENT` 次数 / JSON 字节 | `DEMO_SNAPSHOT` 次数 / JSON 字节 | 完整 ACK packet 字节（含 snapshot） | sameRevision frames | stale frames |
| --- | ---: | ---: | ---: | ---: | ---: |
| GM | 73 / 973,202 | 5 / 30,399 | 130,231 | 13 | 0 |
| PL | 217 / 2,046,403 | 13 / 70,865 | 150,345 | 26 | 0 |
| 合计 | 290 / 3,019,605 | 18 / 101,264 | 280,576 | 39 | 0 |

这九场景的三项 JSON 相加为 3,401,445 bytes，其中包含 27 个命令 ACK。出现 39 个 same-revision frame 不能证明它们全部冗余；独立回归证明倒计时和控制权可能在相同 revision 下变化，因此不能按 revision 相同统一丢弃。

独立前端 store 重放基准使用 40 个实体、500 条日志，10 个 warmup、100 个 measured snapshot。`useDemoStore.setSnapshot` 直接调用耗时 p50=0.8671 ms、p95=1.47 ms、max=1.8026 ms；103 次输入中 102 次应用、1 次 stale 拒绝，same-revision countdown/control 均通过。这个数字来自 Node 中的真实 store 重放，只代表直接 store 更新，不代表浏览器 React render 或网络耗时。

## 决策与后续触发条件

本阶段保留当前 full snapshot + increment 线协议，不实现 delta 协议。理由是 1 GM + 3 玩家、6 实体的正式链路中，服务端 `processPending` p95 约 12.7 ms，前端直接 store 应用 p95 约 1.47 ms；当前证据没有要求立即引入协议复杂度。小场景的 socket 事件体积仍可观测，但尚未显示需要用协议迁移换取延迟的明确收益。

24 实体和长历史场景已经显示体积与广播成本增长：expanded 四 socket event JSON 达 16.80 MB，snapshot p95 达 44.7–55.7 KB，`processPending` p95 29.55 ms；history 的 event JSON 达 12.60 MB，ACK snapshot 合计 1.22 MB。这是后续优化的触发信号，但不能单凭本次少量样本宣称网络瓶颈或虚构带宽结论。

后续若继续优化，顺序应是先在服务端减少同一 revision 的重复 `getSnapshot`、可见性过滤和 JSON 构建，再以同一工作负载比较真正 delta 的 CPU、每 socket JSON、重连/初始 snapshot、same-revision 控制更新和客户端应用次数。delta 只有在优化后大实体/长历史场景仍由 snapshot 体积和广播成本主导，并且能保持这些兼容语义时才值得引入。
