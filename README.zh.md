# dsh-model-rotator · 模型自动排序与故障转移

> **简体中文** | [English](./README.md)

给 DeepSeek Harness 装上一个「换模型的自动驾驶」：当前模型撞上额度墙、密钥失效、被限流，或者网络刚好抖动时，插件会在**同一轮对话之内**换到下一个最合适的已配置模型，继续把这轮回答完——用户看到的仍然是一条普通回复，不会中途断掉。

本机实测规模：**906 个 provider/model**，其中 **384 个**在轮转池里，跨 **48 个渠道**（24 个对话渠道 + 24 个识图渠道）。

## 它到底做了什么

一轮对话失败时，插件依次做这几件事：

1. **摸清家底**：调 `ctx.llm.listProviders()` 加各适配器的 `listModels()`，枚举本机所有能拨通的 `provider/model`。
2. **剔除非对话模型**：向量/重排、语音合成与识别、OCR、图像与视频生成、内容审核、评判模型等，一律不进池子。理由很直接——拨它们只可能让本轮失败，还会白占一个本该留给真模型的冷却位。
3. **跳过识图孪生**：dsh-vision-router 会给每个渠道套一层 `<provider>-vision` 的「识图外壳」，它的作用是给**同一个模型**加读图能力。也就是说，它是同一个模型的第二条通路，不是第二个模型。把文本轮次切过去，等于让回答绕道图像管线；更糟的是「优先选同款模型」这条规则会把孪生排到最前面。所以这些路由**永不作候选**（注意：只是名字里带 `vision` 的真对话模型不受影响，仍然照常参与）。
4. **排序**：按实测连通率（拉普拉斯平滑的成功率）、速度（TTFT 中位数与吞吐）、以及当前冷却状态排出一张候选表。你正在用的那个模型、或者它在别的渠道上的近亲，会拿到加权——毕竟你选它自有道理，多半只是这条渠道坏了。
5. **先重试，再判死**：渠道瞬时抽风很常见（限流毛刺、连接被重置、信道过载），所以单次失败不算故障。同一个模型还会按 `retriesPerModel` 再试几次（默认 2 次，可设 0–5），每次间隔 `retryBackoffMs`（默认 300ms，之后翻倍）。**重试不等于切换**——它不问你、也不改任何状态。
6. **真的换**：在 `llm/stream` 瀑布上接管。第一次尝试走宿主原路径；只有当这次失败**一个字的正文都没产出**时，才放弃这次尝试、关掉它的上游流，用全新的 `ctx.llm.stream()` 重新下发下一候选。

### 两条边界，是整件事的关键

**已经出过正文就不再重试。** 一旦有任何正文分片吐给用户，这次尝试就锁死了——再试一遍会让用户看到重复的文字。所以「可重试窗口」精确等于「零内容窗口」。

**不是所有分片都算内容。** `reasoning-delta` 不算：重试时宿主会把思考过程连同那一轮一起折叠掉，这正是「思考死循环」「思考强度不被支持」这类失败可以安全重试的原因。标记分片（`block-start`，或携带思考块的 `block-end`）也不算。这里踩过坑：早先版本把一个 `block-start` 当成内容，于是窗口刚开就被关上，紧接着的一个普通错误被当成终局——一个明明活着的模型看起来像死了。

**被取消的轮次不折腾。** 用户点了停止、超时到点、客户端断开——走链立即停下，不会把候选浪费在没人再看的回复上。

### 自动调用不当作对话轮次

压缩摘要和会话标题也走同一条 `llm/stream` 接缝，但它们不是用户轮次。这类调用的拒绝，通常说的是**那条专用通道**的状况（比如代理回一句「压缩归 bili 管」），此时换一个 provider 去干这段管道活是错误反应：既花掉一个真模型去做没人读的工作，又是**虚假切换的头号来源**。所以凡是带 `purpose: "compaction"` 或 `purpose: "session-title"` 的调用，一律原样透传，错误也透传；没带标记的普通轮次照旧故障转移。

## 换了模型会告诉你

切换本来是无声的——回复只是换了个模型回来，你根本看不出来。默认情况下插件会在对话里贴一行：

```
模型已切换：硅基流动/deepseek-4.1 → Loomy/deepseek-4.1  (rate-limit)
```

已知失败类型时会带上括号，比如 `(quota)`、`(rate-limit)`。

| 项目 | 做法 |
|------|------|
| 形态 | 复用宿主自带的通知机制：一条 `user/message`，source 是 `{ kind: 'model-rotator/switch', form: 'notice', summary }`。对话界面把它渲染成一条上下文行，而不是你发出去的消息 |
| 时机 | 放在轮次边界，经 `agent/turn-stopping` + `agent.steer` 投递。切换已经发生、回答已经在流，若在轮次中途插一行，就会插在它所描述的回复正中间 |
| 范围 | 只作用于根对话。子代理记录里的切换属于别人的日志，不打扰你 |
| 关掉 | `noticeSwitch: false`，或设置页里的开关 |

事件类型**刻意没自创**。持久化读取器会拒绝解释含有未知类型的事件日志（`dsh-session` 的 `KNOWN_SESSION_EVENT_TYPES`），自创一个类型会让带它的日志直接加载失败。`user/message` 是已知类型，`notice` 是客户端已经理解的形式——宿主自己那条「模型已切换」用的就是这一对。

渠道名优先用宿主发布的 provider `displayName`（`siliconflow` 显示成「硅基流动」、`modelscope` 显示成「魔塔」、`buddy` 显示成 «CodeBuddy (腾讯)»），没有标签的路由才回落到 id；两者不同时会写成「标签 (id)」的形式。

## 换之前先问你

故障转移会替换你亲手选的模型，而且可以不声不响——所以默认**先问**。当前模型零内容失败时，插件经宿主的人机交互接缝（`ctx.userQuestions.askTimed()`）在对话里抛一个问题，给出两个选项：**切换** 和 **保持当前模型**。

| 你的回答 | 结果 |
|----------|------|
| 切换（或任何不算拒绝的回答） | 下一候选接手本轮 |
| 保持当前模型（或直接打出「不/否/取消/拒绝/no/cancel/stop」之类） | 不再拨任何候选，本轮以原始错误结束 |
| 窗口内没回 | 继续切换——这是一次限时征询，不是否决权 |

提问**每轮只问一次**：第一次批准即覆盖这一轮剩下的走链，所以一串坏模型不会变成一串一模一样的卡片。默认等 20 秒，可配。

整个机制刻意是「失败即放行」的：接缝不存在、提问抛错、本轮没有活着的根代理（被委托的子代理没人可答）、或者等超时了——走链都会在未确认的情况下继续。无人值守的宿主绝不该卡在一张没人看的卡片上。

## 失败类型决定后事怎么办

失败不只是一个字符串，它会被归类，而类别决定这个模型要「歇」多久。

**额度墙和限流是两码事。** `429 insufficient balance` 和 `429 too many requests` 是同一个 HTTP 状态码，但一个几秒后自己就活了，另一个得等额度重置。插件会从消息正文里读语义——`insufficient quota`、`out of credits, please top up`、`余额不足，请充值`、`额度已用尽`、`402 Payment Required` 这类——然后区别对待：

| 类型 | 冷却多久 | 要不要先重试 |
|------|----------|--------------|
| `quota`（额度耗尽） | 歇到次日 `quotaCooldownHour`（默认本地 00:00），且不少于 `quotaCooldownMs` | 不重试——两次下发之间余额不会自己长回来 |
| `auth`（鉴权失败） | 常规指数退避 | 重试——被突发限速代理解出来的 403 确实会好 |
| `unsupported`（请求形态不被支持） | 常规指数退避 | 不重试——同一个 provider 对同一个请求只会给同样的拒绝 |
| `rate-limit`（限流） | 常规指数退避 | 重试 |
| `server` / `network`（服务端/网络） | 常规指数退避 | 重试 |
| 未分类 | 常规指数退避 | 重试 |

`unsupported` 指的是请求形态本身被拒，比如「provider X model Y does not support reasoning effort high」「unsupported model」。它在读请求之前就判定了，重试只会逐字复现同一个拒绝——跳过重试，才能把一次会话级不匹配压成**一次切换，而不是三次**。

鉴权失败会**先于**裸 `429` 被归类，因为等待永远修不好一个密钥：对 `429 invalid api key` 来说，诚实的名字是 `auth` 而不是 `rate-limit`。这个区分只用于**记录**，不改变处置——两者退避一样；只有 `quota` 会改变策略。

冷却的下限是「次日 `quotaCooldownHour`」。23:50 撞上的额度墙仍要付满 `quotaCooldownMs`，所以它会在次日 11:50 回来，而不是十分钟后的午夜。

`model_rotator_status` 会把这些都摊开给你看：排名表把这类行标成 `QUOTA-REST`（并附剩余小时数）而不是 `COOLDOWN`，`type` 列写明类别，`last failure seen` 行列出每个模型最近一次错误及其类型。

实测状态——计数器、最近错误与类型、冷却到期时间——**跨进程存活**。理由是现实的：「刚被告知余额用完」之后做的那次重启，不该把冷却一并抹掉。它写在 `%DSH_HOME%\model-rotator\stats.json`（或者 `config.json` 所在目录），去抖落盘，首次使用时读回一次。延迟采样则刻意只留在内存——它们是 20 个样本的滑动窗口，陈旧的窗口比短的更糟。`statsPersistTtlMs` 限制读回文件的年龄（默认 24 小时；设 0 表示完全不用这个文件）。

## 它不碰什么

**它从不读、写或改写模型/provider 配置。** 不碰 `cordis.patch.yml`、不碰 `agent-default-model`、不碰 `llm-pi-ai`、也不碰任何 provider 注册。它只在运行时观察流式瀑布。如果你的 provider 配置被人动过，那一定不是它干的。

## 哪些模型会被过滤掉

宿主适配器在交给 `listModels()` 之前，会把目录自带的 `wire: 'chat'` 标记剥掉，所以没法从返回行上读能力。名字匹配是唯一可用的信号，而且刻意写得很窄——模式绝不能误伤只是**名字里提到**某种模态的对话模型（`Qwen3-VL-8B-Instruct` 是对话模型，保留；`Z-Image-Turbo` 不是，剔除）。

过滤器覆盖向量与排序、语音、图像生成、文档解析、安全分类器这几大族，普通 provider 与 `-vision` 变体都算。它在发现阶段就跑，所以插件报的 `discovered` **已经是过滤后的池子**。也因此，一台机器的数字完全取决于它配了哪些 provider——别从本文档抄数字，直接问实际安装：

```
model_rotator_status      # 看 "discovered" 一行，那就是过滤后的候选数
```

## 三个工具

| 工具 | 干什么 |
|------|--------|
| `model_rotator_status` | 只读：启用状态、配置路径、已发现池、实测排名，附带「当前生效设置来自哪一层」。 |
| `model_rotator_benchmark` | 用最小真实请求探测候选，刷新 TTFT/吞吐与冷却状态（有次数上限，会花掉一点额度）。 |
| `model_rotator_select` | 固定或取消固定转移顺序的队首；队尾仍然由排名决定。 |

状态工具还会报出两个手动清单和识图规则，这样「目录里看得见、排名里看不见」的模型，不必去读代码就能解释清楚：

```
  disabled models  : workbuddy/hy3
  vision twins     : never a candidate (the dsh-vision-router mode wraps a model, it is not a second one)
  model list route : /_dsh/model-rotator/models (GET the grouped list; POST {key, enabled} to switch one off or on)
```

## 配置

可选，路径 `%DSH_HOME%\model-rotator\config.json`，改完即热加载。每个字段都有安全默认值，所以**完全不建这个文件也能跑**。

```json
{
  "enabled": true,
  "allowImageFailover": false,
  "maxCandidates": 4,
  "cooldownBaseMs": 60000,
  "maxCooldownMs": 1800000,
  "quotaCooldownMs": 43200000,
  "quotaCooldownHour": 0,
  "statsPersistTtlMs": 86400000,
  "confirmSwitch": true,
  "confirmTimeoutMs": 20000,
  "adoptSwitchedModel": true,
  "retriesPerModel": 2,
  "retryBackoffMs": 300,
  "preferSameModel": true,
  "weights": { "connectivity": 0.5, "speed": 0.3 },
  "excludeProviders": [],
  "excludeModels": [],
  "excludePatterns": [],
  "disabledModels": [],
  "enabledModels": [],
  "disabledProviders": [],
  "pinned": ""
}
```

- `enabled` —— 总开关。
- `allowImageFailover` —— 图像轮次默认跳过。理由：纯文本备选读不了图，在那里转移只会得到「错误答案」而不是「缺失答案」。
- `maxCandidates` —— 每轮最多试几个（硬上限 8）。
- `cooldownBaseMs` / `maxCooldownMs` —— 指数退避的上下界（`base * 2^(n-1)`，截断到 `max`）。
- `quotaCooldownMs` —— 额度墙之后的最短冷却（默认 12 小时，上限 26 小时）。从失败那一刻起算，不按整点取整。
- `quotaCooldownHour` —— 本地小时（0–23），耗尽的模型可以在这时刻再被尝试（默认 0 = 次日零点）。冷却总是走到**次日**的那个时刻，所以 00:05 撞的墙不会当晚就复活。
- `statsPersistTtlMs` —— 实测状态跨重启存活多久（默认 24 小时，上限 30 天；0 = 不持久化）。
- `confirmSwitch` —— 离开失败模型前先在对话里问一句（默认 `true`，见上文）。
- `confirmTimeoutMs` —— 那个问题等多久之后仍然照切（默认 20000；限 1 秒 … 10 分钟）。
- `adoptSwitchedModel` —— 切换之后，把**真正作答**的模型设成**本会话**的模型，让会话头部显示实际在用的模型（默认 `true`）。仅限会话内：不动 provider 配置、不写任何默认值；宿主自己那条「模型已切换」通告也会随之报出正确的组合。
- `retriesPerModel` —— 认定失败之前同一模型的额外尝试次数（默认 2，硬上限 5）。重试不需要确认，因为它不换模型。
- `retryBackoffMs` —— 每次重试前的停顿（默认 300；第 n 次重试等 n 倍，封顶 10 秒）。
- `preferSameModel` —— 优先排同款模型在别的渠道上，其次近亲，最后才按实测排名（默认 `true`）。
- `noticeSwitch` —— 是否在对话里贴那一行切换通知（默认 `true`）。
- `weights` —— 评分里连通率与速度的配比。
- `excludeProviders` / `excludeModels` —— 把指定路由排除出池子。
- `excludePatterns` —— 追加到非对话黑名单的正则；写错的正则会被跳过，不会致命。
- `disabledModels` —— 在模型列表里逐行关掉的模型。每条是 `"provider/model"`，也可以只写裸模型 id（那样会命中所有提供该模型的渠道）。行级条目压过渠道级规则。
- `disabledProviders` —— 在渠道表头上点「关闭本渠道」关掉的整条渠道，一条记录一个 provider id。关闭渠道时会一并清掉该渠道内遗留的逐行 `enabledModels`，免得按钮被静默撤销；此后单独开启某一行会写一条新记录，照样生效。
- `enabledModels` —— 相反方向。也是当某个 wrapper 命名不符合 `<provider>-vision` 约定时，把识图孪生单独放回轮转的**唯一方式**。由同一个开关写入。
- `pinned` —— 转移顺序的优先队首。

## 设置页与模型列表

插件两半都齐：服务端有给 `model-rotator` 命名空间用的 `Config` schema，浏览器端有 `client.js`（经 `dsh.client` 与 `exports["./client"]` 声明），同一个组件渲染到宿主的两个位置：

- **设置 → 模型自动切换**：设置导航里的独立入口（`settings.section`，id `model-rotator`，order 20）。
- **插件面板**里的 `model-rotator` 卡片（`plugins.item`），卡片正文是同一套表单。

两处都只在宿主真的提供该命名空间时出现。页面上只放「个性化安全」的字段：

| 字段 | 含义 |
|------|------|
| `enabled` | 总开关 |
| `allowImageFailover` | 图像轮次也参与转移 |
| `maxCandidates` | 一轮最多试几个模型 |
| `cooldownBaseMs` | 退避基数 |
| `maxCooldownMs` | 退避上限 |
| `quotaCooldownMs` | 额度墙后的最短冷却 |
| `quotaCooldownHour` | 耗尽模型归来的小时点 |
| `statsPersistTtlMs` | 实测数据跨重启存活多久 |
| `confirmSwitch` | 切换前先问 |
| `confirmTimeoutMs` | 问句等待时长 |
| `adoptSwitchedModel` | 把切换后的模型落到本会话 |
| `retriesPerModel` | 认定失败前的尝试次数 |
| `retryBackoffMs` | 重试之间的停顿 |
| `preferSameModel` | 优先同款模型换渠道 |

`weights.connectivity` / `weights.speed` **不在页面上**：表单模型一次只承载顶层键，嵌套值留在 `config.json`。需要手工或工具批量编辑的长清单——`excludeProviders`、`excludeModels`、`excludePatterns`、`pinned`——也留在那里。

### 模型列表

表单下方，同一页渲染出**模型列表**：每一个已发现的 `provider/model`，带健康状态和自己那一行的开关；另外每条渠道的表头上都有一个开关，**一键关掉该 provider 背后的所有模型**。两级是刻意设计的：密钥或端点整条死掉时，「关整条渠道」才是你要的那一下；而某一个模型坏了、邻居还好着时，你需要的又是行级开关。

列表分成两段，因为它们回答的是两个不同的问题：

| 分区 | 内容 |
|------|------|
| **对话渠道** | 真正参与自动切换的候选 |
| **识图模式（vision-router 创建）** | `<provider>-vision` 孪生，每条都标注它包裹的是哪个渠道（`amd-vision → amd`） |

**折叠分三级、互不干扰**：分区、分区内的渠道、整张表。对话渠道默认展开，识图分区默认**收起**——因为孪生数量和其余模型一样多（本机最近一次实测：906 行里 453 行是孪生），而且它们永不作候选，收起来才让页面可读。**全部展开 / 全部收起** 两个按钮一次操作所有分区与渠道。

真实长相（本机实测）：

```
▼ 对话渠道                    453 个 · 可用 361 · 冷却 23 · 关闭 69
    ▼ 硅基流动 (siliconflow)     65 个 · 可用 63 · 冷却 2 · 关闭 0   [关闭本渠道]
        ● deepseek-v4.1-flash   冷却中   retry in 511m · rate-limit      [关闭]
    ▼ AMD (amd)                  8 个 · 可用 5 · 冷却 3 · 关闭 0   [关闭本渠道]
▶ 识图模式（vision-router 创建）  453 个 · 可用 0 · 冷却 0 · 关闭 453
```

| 列 | 含义 |
|----|------|
| 圆点 + 标签 | `可用`（没在冷却、没有失败记录）、`未测`（还没试过）、`冷却中`、`额度耗尽`（歇到次日边界）、`异常`（上次失败）、`已关闭` |
| 明细 | TTFT 与成功/尝试次数，或剩余冷却，或这一行为什么不在轮转里 |
| 开关 | 关闭 / 启用 |

一行「不在轮转」的原因会写明，而不是笼统灰掉：`manual`（在这里手动关的）、`vision`（识图孪生，默认排除但开关可以推翻）、`provider` / `excluded`（来自 `config.json`）、`non-chat`（非对话模型族）、`combo`（虚拟路由）。**只有前两种能在页面上开关**，其余要么是结构性的，要么归文件管。

渠道级开关的几条规则（都是实测踩出来的）：

1. 表头按钮的标签取自**渠道自己的开关状态**，而不是「有没有某一行在轮转」——整条渠道的行因为行级原因都关着，它依然是**开启**状态；从表头关掉的渠道，必须给出能重新打开它的动作。
2. 已关闭的渠道按钮显示**启用本渠道**，同时下面的行级开关仍然可用，方便你把某一个模型单独放回，而不必整条渠道重开。
3. 关闭渠道会清掉渠道内遗留的逐行覆盖（这样按钮才说到做到）；而你在**这之后**单独打开某一行，那条新记录照样赢（新的、明确的表态压过旧的、笼统的表态）。
4. **识图渠道不提供渠道级开关**。它的行是被孪生规则挡在外面的，渠道开关撬不动它们——放个按钮在那里，等于写了一笔改不动任何东西的配置却看起来像个承诺。请用行级开关。

列表的数据不走设置表单，走 HTTP：路由 `/_dsh/model-rotator/models`。

- `GET` 返回分组列表：`groups` 是两个分区，`channels` 每个 provider 一条（带 `kind` 和孪生所包裹的 `sourceChannel`），`models` 是所有行。分区和渠道带同一套 `models`/`ok`/`resting`/`off` 计数器，所以一种行形状就能渲染两级，折叠时也照样报得出状态。
- `POST {key, enabled, scope}` 翻一个开关并回传刷新后的列表。`scope: "provider"` 用于渠道表头；省略或 `"model"` 用于单行。

表单承载你的**策略**（试几个、等多久），列表是**名册**——provider 一重新发布它就变；而它的每一行是逐个直接写进 `config.json` 的，所以刷新不会把你正打到一半的数字抹掉。路由通过 `ctx.inject(['webServer'], …)` 注册，因为宿主是在插件加载**之后**才发布 web 服务器的；它和其他所有非公开路径一样，由宿主统一做鉴权。

两层配置合并规则是 **默认值 < config.json < 设置页**。设置页只在它真正拥有的键上获胜：它没设过的键，值仍然来自文件。`model_rotator_select` 从不把「页面拥有的键」写回 `config.json`，所以一个陈旧的文件值永远不会伪装成权威。

命名空间就是插件的 cordis id（`model-rotator`）。只有服务端一半、没有客户端一半，页面上什么都看不到——这也是两半必须一起发的原因。`Config` 导出需要 schemastery **在宿主进程内**，所以插件在 `vendor/node_modules/` 里自带了副本，并在裸导入解析不到时按绝对路径加载它——这样在「manifest link 指向 profile 的 `node_modules` 之外」的安装形态上，页面也照样出得来。

`model_rotator_status` 的最后有一块 **in force right now**，逐行列出每个生效键的合并值与它来自哪一层（`[default]` / `[config.json]` / `[settings page]`），不用你自己读两个文件在脑子里做合并。再后面几行给出实时画面：`ask channel`（切换前的问句到底能不能送达你，不能的话为什么）、`adopt on switch`、`model in use now`（从本会话请求头读）、`session switch`、`failure verdict`、`switch order`。

## 安装

```bash
dsh plugin --profile desktop add github:chimneyQ/dsh-model-rotator
```

如果你手上是本地目录，同一条命令换成路径即可：

```bash
dsh plugin --profile desktop add <本目录路径>
```

包内声明了 `dsh.bundle.patch`，所以它自带的 `cordis.patch.yml` 会自动接线；它没有任何需要构建的依赖。装完需要**完整重启**应用才会加载。

确认宿主是否真的把它接上了（首次安装失败可能只写下依赖、却没把插件加入 `dsh.profile.bundles`）：检查 `<DSH_HOME>/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里是否列出 `dsh-model-rotator`。

## 测试

```bash
node test-offline.mjs     # 故障转移 + 确认闸门，跑在 stub 宿手上
node test-settings.mjs    # 服务端设置契约，对着宿主自己的规则
node test-client.mjs      # 浏览器端：加载器形态、卡片注册、字段
node release-check.mjs    # 发布自检：manifest / files / exports / 收录条目
```

四条都不需要网络、也不需要跑着 DSH。离线套件覆盖「失败后重试」「一旦出正文就不再重试」「图像轮次跳过」「所有候选都失败」「冷却记账」「取消信号透传」「经真实瀑布的非对话过滤」「工具注册」「确认闸门」（提问关闭 / 批准 / 按钮拒绝 / 文字拒绝 / 超时 / 每轮一问 / 各条失败即放行路径）。客户端套件用**真实的 hooks 运行时**渲染名册（状态、副作用、记忆化回调、重渲染）并按下读者会按的按钮，断言返回的东西——两个分区、推导出来的计数、每一级折叠的收放、以及列表只被拉取一次。正则只能证明某个功能被提到过，只有渲染才能证明它真的能用；早先一个重复拉取的循环，正是被这套渲染测出来的。

## 许可

MIT
