# Langfuse Cloud 评测系统设计

## 背景

`mini-cc` 已具备模型调用、工具调度、子 Agent、上下文压缩、重试和 Ink TUI，但当前缺少统一的线上链路观测与离线回归评测。目标是使用 Langfuse Cloud 建立一套共享数据口径：真实 CLI 会话用于发现问题，固定数据集用于重复验证，真实 Bad Case 可回流到离线评测集。

本设计只覆盖首期可自动、可验证的核心指标。NPS、定性反馈、行业合规、访问控制等依赖外部数据或人工审核的指标不在首期伪造分数。

## 已确认决策

- 同时建设线上运行观测与离线回归评测。
- 使用 Langfuse Cloud，不部署自托管服务。
- 使用 Langfuse JavaScript v5 的 `@langfuse/tracing` 与 `@langfuse/otel`，不接入旧版 `langfuse` v3 SDK。
- 通过项目内薄适配层隔离 Langfuse SDK，核心循环只依赖项目自己的遥测接口。
- 上传完整 Prompt、模型输出、工具参数和工具结果，不做脱敏或截断。
- 首期覆盖任务完成度、四项输出质量、延迟、Token、模型成本、工具错误、重试和稳定性。
- 内置基准任务与真实 Bad Case 共用 Langfuse Dataset。
- LLM Judge 复用当前 Anthropic 模型，使用独立固定 Prompt。
- 每个离线任务默认顺序运行 3 次。
- 离线评测入口为 `bun run eval`，不修改 `mini-agent` 公共 CLI。

## 成功标准

- 配置 Langfuse Cloud 密钥后，真实 CLI 任务可在 Langfuse 中查看完整 Trace、模型 generation、工具 span、子 Agent 层级、Token、延迟和错误。
- 未配置 Langfuse 密钥时，现有 CLI、TUI 和 Agent 行为不变。
- `bun run eval` 能同步内置基准、读取 Langfuse Dataset、在隔离工作区运行每个任务 3 次，并关联 Dataset Item 与 Experiment Run。
- 每次离线运行同时产出确定性断言结果与四项 Judge 分数。
- Langfuse 中能够按 Git commit、模型 ID 和评测配置比较不同实验。
- Langfuse 上报故障不拖垮正常 CLI；离线评测中的缺失数据和失败必须显式可见。

## 非目标

- 不在首期实现 NPS、用户定性反馈、行业合规、地域合规或访问控制评分。
- 不把 LLM Judge 当作安全或合规审计工具。
- 不新增评测 Web UI，查看与比较结果使用 Langfuse Cloud。
- 不修改现有 `mini-agent` 命令参数或新增可执行文件。
- 不增加任务并发、分布式执行、自动发布门禁或可配置评分权重。
- 不为本地工具虚构货币成本。
- 不重构与观测和评测无关的 TUI、工具或上下文管理代码。

## 隐私边界

完整内容模式会将以下数据发送到 Langfuse Cloud：

- 用户 Prompt 与系统 Prompt。
- 发送给 Anthropic 的消息上下文和模型输出。
- 工具名称、完整参数、完整结果和错误信息。
- 子 Agent 任务描述与输出。
- 工作区、模型、版本和评测元数据。

这些内容可能包含源码、命令输出、文件内容、密钥或个人信息。该行为必须在配置文档中显式说明。未同时配置 `LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY` 时，线上观测默认关闭；不提交任何密钥到 Git。由于用户已经选择完整内容模式，首期不增加脱敏或截断逻辑，也不把安全风险描述成已被消除。

## 总体架构

### 遥测适配层

新增 `src/observability/`，只负责：

- 从环境变量初始化 Langfuse v5 tracing 与 OpenTelemetry 导出。
- 提供项目内 `Telemetry` 接口和空实现。
- 创建、结束和标记 Trace、generation、span 与事件。
- 记录评分并限时刷新上报队列。
- 将 Langfuse 初始化或上报错误转换为简洁警告。

`agentLoop`、模型调用和工具执行只调用项目内接口，不直接散落 Langfuse SDK 类型和 API。测试通过假的 `Telemetry` 验证层级与字段，不访问 Cloud。

### 生命周期边界

- 一次 CLI 用户任务对应一个根 Trace。
- 一次 `agentLoop` 对应根执行 span；子 Agent 对应嵌套的子执行 span，并记录 `depth`。
- 每次 Anthropic 请求对应一个 generation，包括续写、重试后的实际请求和用于上下文摘要的模型请求。
- 每次工具调用对应一个 span，包括权限拒绝、运行错误与成功结果。
- 瞬态重试、模型切换、上下文压缩和流中断记录为当前执行或 generation 下的事件。
- 根 Trace 在任务成功、异常或达到最大步数时统一结束。

现有 `AgentEvents` 继续服务 TUI 展示。遥测需要模型输入输出、Token、首 Token 时间、重试和结束状态等更完整信息，因此不通过扩展 UI 事件来间接拼装 Trace。

### 离线评测模块

新增 `src/evaluation/`，职责分为：

- Dataset 同步和读取。
- 内置任务定义与固定夹具。
- 临时工作区创建、运行和清理。
- 确定性断言执行。
- LLM Judge 请求与结构化结果校验。
- 3 次重复运行与聚合报告。
- Dataset Item、Experiment Run、Trace 和 Score 的关联。

`bun run eval` 是唯一入口。评测 Runner 调用正式 `agentLoop`，不复制一套 Agent 实现。

## 在线数据流

1. CLI 接收非空用户任务，创建根 Trace，记录会话 ID、模型 ID、工作区、应用版本和 Git commit。
2. `agentLoop` 创建执行 span，子 Agent 在父上下文中创建嵌套执行 span。
3. 模型调用创建 generation，记录完整输入、输出、模型、Token、首 Token 延迟、总耗时、停止原因和错误。
4. 工具调用创建 span，记录完整输入、输出、工具名、成功状态、耗时和错误类型。
5. 重试、回退模型、上下文压缩和流中断作为事件附着到对应上下文。
6. Agent 成功返回或抛出异常时，根 Trace 记录最终输出、状态和错误分类。
7. 正常退出前限时刷新上报队列；超时只警告，不阻塞 CLI 退出。

Langfuse 初始化或上报失败不得改变 Agent 的模型调用、工具执行、消息状态或用户可见结果。

## 离线数据流

1. `bun run eval` 校验 Langfuse Cloud 配置；缺少密钥时直接失败。
2. Runner 将仓库内置基准按稳定 ID 同步到指定 Langfuse Dataset，重复运行不创建重复 Item。
3. Runner 读取 Dataset 当前快照，同时包含从真实 Trace 回流且已补充预期结果的 Bad Case。
4. 每个 Dataset Item 默认顺序运行 3 次。每次运行从相同夹具创建独立临时工作区。
5. 正式 `agentLoop` 在该工作区执行任务，并创建关联 Dataset Item 和 Experiment Run 的 Trace。
6. 任务结束后先运行确定性断言，再调用独立 Judge。
7. 断言结果、四项 Judge 分数、错误分类和运行元数据写回对应实验。
8. 聚合器输出本次实验的成功率、质量均值与标准差、延迟、Token、成本和工具错误摘要。
9. 成功运行后清理临时工作区；失败运行保留路径并在报告中提示，供人工排查。

每次实验记录 Dataset 快照标识、Git commit、模型 ID、Judge 模型 ID、重复次数和评分规则版本，避免不同配置的结果被误认为同口径比较。

## 数据集设计

每个 Dataset Item 至少包含：

- 稳定的任务 ID 和中文名称。
- 用户 Prompt。
- 夹具类型或夹具路径。
- 确定性断言列表。
- Judge 评分所需的任务目标和补充标准。
- 来源：`builtin` 或 `bad-case`。
- 可选的来源 Trace ID。

首批内置基准控制在 5 至 10 个代表性编码任务，覆盖：

- 只读理解与准确回答。
- 创建或修改指定文件。
- 运行测试并基于结果完成修复。
- 工具失败后的恢复。
- 多步骤任务和 `todo_write` 状态完成。

内置任务使用小型固定夹具，不直接在当前仓库上执行写操作。Bad Case 只有在人工补齐预期结果和确定性断言后才进入回归集；仅把失败 Trace 加入 Dataset 不等于已经具备可信评测标准。

## 指标定义

### 功能与质量

- **任务成功率**：所有确定性断言通过的运行数除以总运行数。
- **首次成功率**：每个任务第 1 次运行成功数除以任务总数。
- **子任务完成率**：通过的断言数除以断言总数。
- **准确性、相关性、完整性、创造性**：Judge 分别输出 `0` 到 `1` 的分数和中文理由。
- **任务质量**：四项 Judge 分数的算术平均值。

确定性断言是任务完成度的事实来源。Judge 分数不覆盖失败的测试或断言；任务质量与任务成功状态分别展示。

### 性能与成本

- **端到端延迟**：任务开始到 Agent 成功或失败结束的时间。
- **首 Token 延迟**：模型请求发出到收到首个文本 Token 的时间；不称为隐藏思考时间。
- **模型调用时间**：每次 Anthropic 请求的完整耗时。
- **工具调用时间**：每个工具 span 的耗时，并按工具名聚合。
- **Token 消耗**：generation 的输入、输出和总 Token，并聚合到任务和实验。
- **API 成本**：优先由 Langfuse 按模型 ID 和 Token 计算；无法识别时标记为未知，不记作零。
- **工具成本**：本地工具只记录调用次数与耗时，首期不计算货币成本。

### 可靠性与稳定性

- **工具错误率**：失败工具调用数除以工具调用总数。
- **重试成功率**：发生瞬态重试后最终成功的请求数除以发生重试的请求数。
- **错误类型分布**：按模型错误、工具错误、断言失败、最大步数和 Judge 解析错误分类。
- **稳定性**：同一任务 3 次运行的成功率、质量分数标准差、延迟波动和 Token 波动。
- **版本对比**：按 Git commit、主模型 ID、Judge 模型 ID 和评分规则版本比较 Experiment Run。

首期只采集分布，不设置自动发布门槛。需要在获得一批真实基线后，再单独设计阈值。

## Judge 设计

Judge 直接调用当前配置的 Anthropic 模型，但使用独立固定系统 Prompt，不加载 Agent 工具、技能、会话消息或工作区上下文。输入只包含任务目标、预期标准、确定性断言摘要和待评输出。

Judge 必须返回结构化 JSON：

- `accuracy`：准确性分数与理由。
- `relevance`：相关性分数与理由。
- `completeness`：完整性分数与理由。
- `creativity`：创造性分数与理由。

每项分数限定在 `0` 到 `1`。解析或校验失败时只重试一次；仍失败则记录 Judge 错误并将四项分数标记为缺失，不用默认分数掩盖故障。Judge 请求自身也记录 generation 和 Token 成本，但不得计入被评 Agent 的任务 Token。

## 配置

计划支持以下环境变量：

- `LANGFUSE_PUBLIC_KEY`：Langfuse Cloud 公钥。
- `LANGFUSE_SECRET_KEY`：Langfuse Cloud 私钥。
- `LANGFUSE_BASE_URL`：可选，Cloud 使用官方地址；保留 SDK 标准配置能力，不在首期部署自托管服务。
- `LANGFUSE_DATASET_NAME`：可选，指定评测数据集名称；未配置时使用项目固定默认值。

线上观测只有在公钥和私钥同时存在时启用。离线评测要求二者都存在。密钥只保存在未提交的本地 `.env` 或进程环境中。

## 失败处理

- 线上 Langfuse 初始化、上报或刷新失败：输出一次简洁警告，Agent 继续运行。
- 离线缺少 Langfuse 配置或无法读取 Dataset：整次评测失败并返回非零退出码。
- 单个任务失败：记录错误后继续其余任务，不中止整批实验。
- Judge 失败：保留 Agent 运行与断言结果，质量分数标记缺失。
- 确定性断言执行错误：区别于断言不通过，记录为评测基础设施错误。
- 临时工作区清理失败：保留路径并警告，不删除工作区外文件。
- Langfuse 成本无法计算：标记未知，不使用零值。

## 测试方案

### 单元测试

- 空遥测实现不改变现有调用结果。
- 假遥测正确接收 Trace、generation、工具 span、子 Agent 层级、事件、Token 和错误状态。
- 配置缺失、部分缺失和完整配置分别选择正确实现。
- Judge 正常 JSON、越界分数、无效 JSON、一次重试和最终缺失分数。
- 任务成功率、首次成功率、子任务完成率、均值、标准差和错误率公式。
- Dataset 内置任务同步使用稳定 ID，重复同步保持幂等。

### 集成测试

- 在小型临时仓库中执行文件修改、测试修复和失败恢复任务。
- 验证每个任务创建独立工作区，运行之间没有文件污染。
- 验证 3 次重复运行与聚合结果。
- 验证确定性断言失败时 Judge 分数不会把任务改为成功。
- 验证单项失败后批次继续运行并返回完整摘要。
- 所有自动测试使用假的 Langfuse 与假的 Judge，不访问网络。

### 验证顺序

1. `bun test`。
2. `bun run typecheck`。
3. `bun run build`。
4. `git diff --check`。
5. 使用本地 `.env` 中的真实 Langfuse Cloud 密钥运行最小冒烟实验。
6. 在 Langfuse 页面人工确认 Trace、generation、span、Dataset Run 和 Score 可见且层级正确。

真实 Cloud 冒烟测试只证明接入链路可用；自动测试仍需独立通过，不能用页面截图替代代码验证。

## 交付范围

- Langfuse v5 遥测适配层和空实现。
- CLI、Agent、模型与工具生命周期埋点。
- `src/evaluation/` 离线 Runner、内置基准、断言、Judge 和聚合。
- `bun run eval` 脚本。
- 环境变量与隐私风险说明。
- 单元测试、集成测试和一次真实 Cloud 冒烟验证。
