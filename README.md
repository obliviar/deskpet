请注意，现在这只是个空的框架，obliviar还在研究框架。。。
kids，快帮忙看看，experiment是我用ai搞出来试试的，接的是deepseekpro，可以跑起来试试
# desk 项目架构逻辑思路文档报告


## 一、项目定位

**desk** 是一个基于 **TypeScript + Node.js** 构建的 **AI Agent 框架**，采用 **pnpm + Turborepo** 管理的 **Monorepo** 架构。从目录结构和文件命名可以明确推断，该项目旨在构建一个具备多模态交互能力、工具调用能力、长期/短期记忆管理能力的智能代理运行时系统。

---

## 二、整体架构概览

```
┌──────────────────────────────────────────────────────────────┐
│                        Apps Layer (应用层)                    │
│  ┌─────────────────────┐    ┌──────────────────────────┐     │
│  │     apps/cli        │    │       apps/server         │     │
│  │  命令行交互入口       │    │     HTTP REST API 入口    │     │
│  │  (chat / voice)     │    │    (chat / voice routes)  │     │
│  └─────────┬───────────┘    └────────────┬─────────────┘     │
│            │                              │                   │
├────────────┼──────────────────────────────┼───────────────────┤
│            │        Packages Layer (包层)  │                   │
│            ▼                              ▼                   │
│  ┌─────────────────────────────────────────────────┐         │
│  │              packages/contracts                   │         │
│  │          共享类型定义 & 端口接口                   │         │
│  │    (types/  +  ports/  +  hooks/)                │         │
│  │          ★ 六边形架构的"端口"层                   │         │
│  └────────────────────┬────────────────────────────┘         │
│                       │                                       │
│       ┌───────────────┼───────────────┐                       │
│       ▼               ▼               ▼                       │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                  │
│  │  core    │   │llm-openai│   │  memory  │                  │
│  │核心运行时 │   │OpenAI适配│   │ 记忆管理 │                  │
│  └──────────┘   └──────────┘   └──────────┘                  │
│  ┌──────────┐   ┌──────────┐                                  │
│  │  tools   │   │  voice   │                                  │
│  │ 工具系统 │   │语音 STT/TTS│                                 │
│  └──────────┘   └──────────┘                                  │
└──────────────────────────────────────────────────────────────┘
```

---

## 三、分层架构详解

### 3.1 应用层（apps/）

提供两种对外服务入口，均依赖底层 packages 实现功能：

| 应用 | 路径 | 职责 |
|------|------|------|
| **CLI** | `apps/cli/` | 命令行终端交互，用户通过终端与 Agent 对话 |
| **Server** | `apps/server/` | HTTP 服务，提供 RESTful API 供其他系统调用 |

**CLI 内部结构：**
- `src/index.ts` — CLI 入口，解析命令行参数
- `src/config.ts` — 配置加载（环境变量、配置文件等）
- `src/commands/chat.ts` — 文本对话命令
- `src/commands/voice.ts` — 语音交互命令

**Server 内部结构：**
- `src/index.ts` — 服务端入口，启动 HTTP 服务器
- `src/wire.ts` — 依赖注入/装配模块（Wire：连线）
- `src/routes/chat.ts` — 文本对话 API 路由
- `src/routes/voice.ts` — 语音交互 API 路由

---

### 3.2 契约层（packages/contracts/）★ 架构核心

这是整个系统的 **抽象接口层**，遵循**六边形架构（端口-适配器）**模式。只定义"是什么"，不定义"怎么做"。

```
contracts/src/
├── index.ts              # 统一导出
├── types/                # 纯数据类型定义
│   ├── chat.ts           # ChatMessage、对话历史等类型
│   ├── llm.ts            # LLM 模型配置、请求/响应类型
│   └── tool.ts           # Tool 定义、参数、结果类型
├── ports/                # 端口接口（抽象层）★
│   ├── context-port.ts   # 上下文窗口管理接口
│   ├── llm-port.ts       # LLM 调用接口
│   ├── memory-port.ts    # 记忆读写接口
│   ├── session-port.ts   # 会话管理接口
│   ├── stream-port.ts    # 流式输出接口
│   ├── tool-port.ts      # 工具注册/执行接口
│   └── voice-port.ts     # 语音输入/输出接口
└── hooks/
    └── hook-types.ts     # Agent 生命周期钩子类型
```

**设计意图：**
- `contracts` 包是零依赖的纯抽象层，不包含任何实现
- 每个 `port` 定义一个接口，下游包像"插头"一样接入
- 这确保了核心运行时（core）可以依赖接口编程，做到实现可替换
- 例如：`llm-port.ts` 定义了 LLM 调用的接口，`packages/llm-openai` 就是它的一个具体适配器实现

---

### 3.3 核心运行时层（packages/core/）★ 引擎中枢

这是 Agent 的大脑，负责编排整个请求-响应生命周期。

```
core/src/
├── index.ts                    # 统一导出
├── runtime/
│   ├── agent-runtime.ts        # ★ Agent 主循环：接收输入 → 思考 → 执行工具 → 生成响应
│   ├── agent-runtime.test.ts   # 单元测试
│   ├── hooks.ts                # 生命周期钩子系统（before/after 拦截点）
│   └── response-parser.ts      # LLM 响应解析器（解析 function call、结构化输出等）
├── session/
│   ├── session-manager.ts      # 会话管理器（创建、恢复、销毁会话）
│   └── in-memory-session.ts    # 内存中的会话存储实现
├── context/
│   └── context-registry.ts     # 上下文注册表（管理 context window 内容）
└── prompt/
    ├── system-prompt.ts        # 系统提示词构造器
    └── context-prompt.ts       # 上下文提示词组装（将记忆、工具描述等注入 prompt）
```

**核心执行流程（推断）：**

```
用户输入
    │
    ▼
session-manager.ts          ← 获取/创建会话
    │
    ▼
context-registry.ts         ← 组装上下文（历史消息 + 记忆 + 工具描述）
    │
    ▼
system-prompt.ts            ← 注入系统提示词
context-prompt.ts
    │
    ▼
agent-runtime.ts            ← 调用 hooks（before）
    │
    ▼
llm-port (接口调用)          ← 请求 LLM
    │
    ▼
response-parser.ts          ← 解析响应（纯文本 / tool_call / 结构化）
    │
    ├── 是 tool_call ──→ tool-port (执行工具) ──→ 回到 context-registry（结果注入上下文）
    │                                                └── 再次调用 LLM
    │
    └── 是文本响应 ──→ hooks（after）──→ 返回用户
                           │
                           ▼
                    memory-port（写入记忆）
```

---

### 3.4 适配器层（packages/）

每个子包都是对某个 `port` 接口的具体实现，遵循适配器模式：

#### packages/llm-openai/ — OpenAI LLM 适配器

| 文件 | 功能 |
|------|------|
| `openai-llm.ts` | 标准文本 LLM 调用适配（GPT-4、GPT-4o 等） |
| `openai-multimodal.ts` | 多模态调用适配（视觉理解、音频输入等） |
| `providers.ts` | Provider 配置（API Key、Base URL、模型映射等） |

- 实现 `llm-port.ts` 接口
- 实现 `stream-port.ts` 接口（SSE 流式输出）

#### packages/memory/ — 记忆系统

| 文件 | 功能 |
|------|------|
| `short-term/session-store.ts` | 短期记忆：当前会话内的对话历史 |
| `long-term/vector-store.ts` | 长期记忆：向量数据库存储 |
| `long-term/memory-writer.ts` | 记忆写入器（将重要信息提取并存入长期记忆） |
| `retrieval.ts` | 记忆检索（RAG：检索增强生成） |

- 实现 `memory-port.ts` 接口
- 短期记忆 = 当前会话上下文窗口
- 长期记忆 = 跨会话持久化存储（向量检索）

#### packages/tools/ — 工具系统

| 文件 | 功能 |
|------|------|
| `registry.ts` | 工具注册表（注册可用的 function tools） |
| `executor.ts` | 工具执行器（接收 tool_call，执行对应函数） |
| `schemas.ts` | 工具参数 Schema 定义（Zod/JSON Schema） |
| `builtin/file-read.ts` | 内置工具：文件读取 |
| `builtin/http-fetch.ts` | 内置工具：HTTP 请求 |
| `builtin/web-search.ts` | 内置工具：网页搜索 |

- 实现 `tool-port.ts` 接口
- 工具注册 → LLM 选择调用 → executor 执行 → 结果返回上下文

#### packages/voice/ — 语音系统

| 文件 | 功能 |
|------|------|
| `stt/openai-stt.ts` | Speech-to-Text：语音转文字（Whisper API） |
| `stt/vad.ts` | Voice Activity Detection：语音活动检测 |
| `tts/openai-tts.ts` | Text-to-Speech：文字转语音 |
| `tts/audio-stream.ts` | 音频流管理 |

- 实现 `voice-port.ts` 接口
- VAD 用于检测用户是否在说话（交互式语音场景）

---

## 四、技术栈推断

| 技术 | 证据 | 用途 |
|------|------|------|
| **TypeScript** | 所有源文件为 `.ts` | 类型安全的主语言 |
| **Node.js** | `.ts` 文件 + `package.json` 模式 | 运行时 |
| **pnpm** | `pnpm-workspace.yaml` | 包管理器 + 工作空间 |
| **Turborepo** | `turbo.json` | Monorepo 构建编排 |
| **OpenAI SDK** | 文件命名以 `openai-` 为前缀 | LLM/STT/TTS 提供商 |
| **向量数据库** | `vector-store.ts` | 长期记忆/RAG |
| **Zod（推测）** | `schemas.ts` | 工具参数验证 |

---

## 五、数据流与关键路径

### 5.1 文本对话流程

```
CLI/Server → session-manager → context-registry
    → system-prompt (+ context-prompt 注入工具描述)
    → agent-runtime (LLM 调用)
    → [循环：tool_call → executor → context 注入 → LLM 再调用]
    → 文本响应 → memory 写入 → 返回用户
```

### 5.2 语音对话流程

```
用户语音 → VAD 检测 → STT 转文字
    → 进入"文本对话流程"
    → LLM 响应 → TTS 转语音 → 音频流返回
```

### 5.3 记忆管理流程

```
对话中：
  short-term (session-store) ← 实时追加消息
    │
对话后：
  memory-writer 提取关键信息 → vector-store 向量化存储
    │
新对话：
  retrieval 检索相关记忆 → 注入 context → LLM 获得上下文
```

---

## 六、架构设计模式总结

| 模式 | 体现位置 | 说明 |
|------|----------|------|
| **六边形架构（端口-适配器）** | `contracts/ports/` + 各 packages | 核心逻辑不依赖具体实现，可替换任意 LLM/存储/语音提供商 |
| **依赖倒置** | `core` 依赖 `contracts` 抽象，不依赖具体实现 | Agent 运行时只认接口 |
| **单一职责** | 每个 package 独立处理一个领域 | llm-openai 只管 LLM，memory 只管记忆，互不干扰 |
| **Monorepo** | pnpm workspace + Turborepo | 统一管理、统一构建、统一版本 |
| **策略模式** | 各 port 的多个实现（可扩展非 OpenAI 提供商） | 便于未来接入 Anthropic、Google 等 |
| **生命周期钩子** | `hooks.ts` + `hook-types.ts` | 插件化扩展点，允许在 Agent 各阶段插入自定义逻辑 |

---

## 七、项目当前状态与下一步推测

### 当前状态
项目目前处于 **架构骨架阶段**：目录结构和文件已全部创建，但所有 63 个文件内容均为空。Git 只有一次 `framework` 提交记录。

### 推测的下一步实现顺序

1. **contracts（契约先行）** — 定义所有类型和端口接口
2. **core（核心运行时）** — 实现 Agent 主循环、会话管理、提示词构造
3. **llm-openai（LLM 适配器）** — 实现 OpenAI 接口适配
4. **tools（工具系统）** — 实现工具注册和执行
5. **memory（记忆系统）** — 实现短期/长期记忆
6. **voice（语音系统）** — 实现 STT/TTS
7. **cli + server（应用层）** — 实现两个对外入口
8. **配置文件填充** — `package.json`、`tsconfig.base.json`、`turbo.json`、`pnpm-workspace.yaml`

---
