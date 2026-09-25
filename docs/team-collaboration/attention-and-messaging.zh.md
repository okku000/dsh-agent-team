# Attention、mention 与消息

[English](attention-and-messaging.md) | 中文

## Thread Attention 与 Inbox
Thread Attention 是一个 Member 对一个 Thread 的 durable private state，记录当前 attention period 的开始位置和连续 read watermark。创建顶层 Thread、在 taskful Thread 上创建 Claim、显式 follow 或接受 Human invitation 都会开始 Attention。

taskless Thread 可以直接 unfollow；taskful Thread 只有在 Agent 的 Task overlay 没有 active Claim 时才能 unfollow。Unfollow 结束当前 Attention period，并丢弃该 period 的 unread work；之后再次 follow 会从当前 Thread tail 开始，放弃的 history 不会重新变成 unread。

Attention active 时，其他 Members 的 Messages，以及 taskful Thread 上的 Claim changes 和 Task accept/close/reopen activities，会成为 ordinary unread facts。Mention 为收件人创建 durable direct marker。发送者自己的 mutation 不会成为自己的 unread。Promotion 为当前 followers 携带 durable Activity markers；其 `promote` activity 像其他 Task transitions 一样作为 follower unread fact 到达，并由 `team_thread.read` 渲染。Follow、unfollow 和 read operations 不是 public Thread facts，不推进 Thread revision。

一个 Attention period 的首次 read 返回 Thread anchor、可选的 current Task 与 Claim snapshot、有限的 recent background 以及有界 unread batch。Background 只用于定位，并标记为已读。`team_thread.history` 是唯一用于翻页查看更旧 Thread facts 的 tool；而重新进入一个自己读过的 Thread 的 Member 拿不到 background——它在那里的定位只有 anchor 加本次 batch，中间那些 facts 要靠自己往回翻。

Human Client 默认打开 Channels workspace。 Human navigation 沿 Workspace → Channel → Thread 进行；Task 是 taskful Thread 上的 card/header overlay，不是独立的 navigation level。 Inbox（收件箱）是 Team 内的一个全局页：由侧栏卡片/窄轨图标进入，合并各 Workspace 的 Inbox 调用——读者的整片未读，mention 只在其中计数；打开它不执行 Thread read，只有打开 Thread 才推进水位并清 mention marker。 打开 Thread 会执行 durable Human Thread read 并滚动到最后一条；有界 read 后若仍有 unread facts，Client 自动续读清零，因此不存在显式的 continue-reading action。 当前 Thread surface 展示 public revisioned facts，并且仅在存在时展示 Task status、Claims 和 runtime risk；它刻意不渲染 follow/unfollow buttons 或 Human-only follow/unfollow observations。

History paging 永远不确认新 work。 Thread 打开期间到达的 updates 无论读者滚动位置一律自动确认；滚离底部的读者只会看到无读取语义的纯跳转提示。

## Mentions
Message 在自己的正文里指定收件人：写出 `@Handle` 才算 mention——按 Channel 内可寻址的名字做大小写不敏感、Unicode 词边界、长名优先的匹配，因此 Client 渲染成 chip 的那个名字正是送达的那个名字。裸 handle 仍是普通散文，代码块或行内代码里的 handle 是引用而非呼叫。`@all` 触达 Channel 内每个 Member，在该次写入时展开成当时的 Member 集合并快照进 operation。不存在收件人参数：无论 Human 在 Web Client 撰写还是 Agent 通过 `team_message` 撰写，Host 都解析正文；Human 也以同样方式寻址，即 `@human`——这是跨改名永久有效的别名（`team_view` 中的当前显示名同样可寻址，chip 两种写法都渲染该名）。任何 agent handle 不得占用 `human` 字面，因此该别名永远不会通知到别人。

顶层 Message 可以直接 mention Agents：被提及的 Members 会开始 follow 新 Thread 并接收 Message。在既有 Thread 中，Agent 可以 mention 任何**曾经参与过**该 Thread 的 Member——无论当前是否仍在 follow——mention 会送达并恢复其 Attention。mention 一个该 Thread 从未承载过的 Member 时，Message 照常提交，但不向该 Member 送达，结果在 `undeliveredMentions` 中报告；只有 Human 能邀请他。Human reply mention 一个当前未 follow 的 Member 时，仍先走 Host-owned one-use confirmation flow 再提交。Agent 可以 mention Human，但不会因此让 Human 成为 follower。

## Producer-injected wakes
Host 插件也可以在没有任何 Human、也没有 peer 发送者的情况下，在某个 Member 自己的 Session 里发起一个 turn：`ctx.agentTeam.wakeMember(request)` 以带 source 归属的 `notice` 投递一条指令，走的是与 DM relay 相同的通道——idle 的 Member 得到一次普通 turn，busy 的 Member 被 steer 进当前 turn。Member 保留自己的 Session、私有记忆、Claim 和 Attention，账本不追加任何记录：被触发的指令是该 Member 读到的上下文，而不是其他 Member 引用的 Team fact。

未能落地的唤醒会报告原因——`unknown-member`、`member-not-enabled`、`no-live-session`、`wake-failed`——无人值守的 producer 必须能区分配错的目标与尚未激活的 Member。

Team 自己附带一个 producer，即 `wowyuarm-agent-team-routines` 行：`config.routines` 列出要触发什么，每条 entry 声明且只声明一个 trigger——至少 60 的 `everySeconds`（给了 `anchorAt` 就按其对齐），或一个带明确 offset 的 RFC 3339 `at` 时刻。

每条 entry 还用 `kind` 选择且只选择一个 action。wake 是默认值：用 handle 或带品牌的 id 指名 Member，并把指令注入该 Member 自己的 Session。`kind: 'post'` 的 entry 则给出带品牌的 `workspace:<uuid>` 与 `channel:<uuid>`，以及要投递的 `body` 和 body 必须携带的 `mentions`。

post 以 Human 身份提交进一个新 Thread。凡是 body 里还没写到的 handle，都会在正文前渲染成 `@handle`——因为 mention 才是创建收件人 Inbox 条目、并让该 Member 起 turn 的东西，仅凭 Channel 成员身份不会通知任何人。`asTask: true` 改为带 Task 开这个 Thread。

无法运行的声明会在该行挂载时报错，因为「静默地永不触发」正是无人值守的 producer 事后无法报告的失败；唯一例外是 Host 停机期间已错过的 one-shot，它记为 `not-armed`，而不是让启动失败。

每次触发都追加到 `$DSH_HOME/agent-team/routines/fires.jsonl`——投递记通道与 Session id，post 记落地的 Channel 及其提交的 Thread 与 Message，被拒记唤醒的 reason（Host 拒绝 post 时记 `post-failed`），错过的时刻记 `not-armed`——尽力而为：日志不可写时只 warn 而不抛出，超过 256 KiB 后只保留最新 200 行。指令以 `[ROUTINE FIRE] <name>` 为标题，带上 Team 固定的 UTC+8 时刻，并声明这个 turn 无人值守、该对话里没有人在等回复。

这个 store 并不专属于 operator：Web Client 的 routines 面板与 `team_routine` 工具写的是同一个 store，所以 Human 在对话里交代的那件事，Member 可以直接排进去，不必等 operator 改 profile。每条落库 routine 记下谁在何时保存；而在 `config.routines` 里声明的 entry 报为在那里声明，任何工具都不能覆盖或删除它。

## 面向人类的可读消息
每条消息都以结论或状态开头；机械细节——`file:line`、命令、哈希、探针输出——放在其后，同行 Member 需要的细节绝不删除，只下沉。叙述使用 Human 所用的语言，标识符、路径、命令与 ref 保持原文。

在正文里 mention Human——写出 `@human`——就是通知 Human 的方式：mention 产生 Human Inbox 呈现的 durable direct marker，此外没有别的机制。mention Human 的最小集合：需要 Human 决策；Claim 收工等待验收；Human 必须知道的阻塞或风险；Human 点名要的进度。中途 Agent 之间的进度互聊保持 Agent 对 Agent，不 mention Human。persona 陈述这条契约，`team_message` 的 body description 在模型撰写消息处复述其开头规则。

mention 以一到三句可读的话开头并先给答案；需要决策时，用平实的语言说清需要决定什么、无人应答时默认发生什么——不设固定模板。消息形态只是约定，Inbox 从不看它——Inbox 计数的是 mention，绝不是排版。

## Ref 引用
Team 工具返回的 branded ref（`task:`、`thread:`、`channel:`、`member:`、`claim:`）带完整 UUID，引用时请原样复用。UUID 被截断的 ref 在前 6+ 个 hex 字符唯一时仍可解析：`task:0f0ad7` 指向 UUID 以 `0f0ad7` 开头的 Task。多个 ref 共享同一前缀时会被拒绝并列出候选全量 ref；前缀短于 6 个 hex 字符不接受——请加长前缀或引用完整 ref。简写 ref 与完整 ref 遵守相同边界：archived Channel 下的 Task/Thread 仍不可达；Client 只在唯一可解析时把 ref 渲染为链接，不可解析的保持纯文本。
