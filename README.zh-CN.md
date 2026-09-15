# cn-websearch-mcp

**一个 MCP 工具,多家国产大模型搜索后端。** 一个 [Model Context Protocol](https://modelcontextprotocol.io) server,把 **Kimi(Moonshot)**、**小米 MiMo**、**智谱 GLM**、**StepFun** 的官方内置联网搜索统一在单个 `web_search` 工具之后——支持自定义 provider 优先级、自动降级、多源聚合、按次超时与瞬时错误重试。

## 它能做什么

各家的联网搜索 wire format 互不兼容:Kimi 要走 4 步 chat "formula" 循环 + 服务端 fiber 执行;MiMo 在 OpenAI chat completions 上挂 `web_search` 工具;智谱是独立的 Search REST API;StepFun 有专用 `/v1/search` 端点。本 server 把它们归一化为同一 schema,并提供两种策略:

- **`fallback`**(默认)——按**你的**优先级顺序依次尝试,第一个成功的即返回。请求少、延迟低。
- **`aggregate`**——并行查询多个 provider,合并结果、按 URL 去重,并给每条结果标注来源。覆盖更广。

```
fallback:   kimi ──✓ 1.2s → 返回            aggregate:  kimi  ─┐
            stepfun (kimi 失败才试)                     stepfun ─┼─→ 合并去重 → 返回
            zhipu   (以上都失败才试)                     zhipu   ─┘
```

## 安装

需要 Node >= 18。从源码:

```bash
npm install
npm run build     # tsc → dist/
```

包发布到 npm 后 `npx cn-websearch-mcp` 也可用(目前尚未发布)。

至少提供一把 provider API key——环境变量、`.env` 文件或 JSON 配置文件都行(见[配置](#配置))。没配 key 的 provider 自动跳过。

## 作为 MCP server 使用

让 MCP 客户端指向构建产物。**key 写进客户端的 `env` 块**——server 是按自身工作目录查找 `.env` 的,而客户端的工作目录不一定是你项目目录。

```json
{
  "mcpServers": {
    "cn-websearch": {
      "command": "node",
      "args": ["/绝对路径/cn-websearch-mcp/dist/index.js"],
      "env": {
        "STEPFUN_API_KEY": "sk-...",
        "WEBSEARCH_STRATEGY": "aggregate"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add cn-websearch -e STEPFUN_API_KEY=sk-... -- node /绝对路径/cn-websearch-mcp/dist/index.js
```

无参数启动即 stdio MCP 服务,因此既有的 MCP 客户端配置无需改动。

## 在终端使用

同一个二进制也是 CLI,不必配客户端就能搜索和测试。

```bash
cn-websearch-mcp                       # 启动 MCP stdio 服务(默认)
cn-websearch-mcp search "查询词"        # 一次性搜索
cn-websearch-mcp search --strategy aggregate --count 12 "查询词"
cn-websearch-mcp status                # 生效配置 + provider 状态
cn-websearch-mcp test                  # 逐个探测就绪的 provider
cn-websearch-mcp repl                  # 交互式会话
cn-websearch-mcp help                  # 完整用法
```

选项:`-n/--count <1-50>`、`--strategy fallback|aggregate`、`--providers a,b`(仅本次调用生效)、`--no-dedupe`、`-q/--query`(`test` 的查询词)、`--json`(原始输出,便于脚本消费)、`-h`、`-v`。

退出码:`0` 成功、`1` 运行失败(搜索失败/无可用 provider)、`2` 用法错误——脚本与 CI 可据此分支。

交互式会话里,裸文本即搜索,`/` 命令控制会话:

```
cn-websearch> 最近一周国内发布的大模型
cn-websearch> /strategy aggregate      # 本会话切到多源
cn-websearch> /aggregate rust async    # 一次性多源搜索
cn-websearch> /count 12
cn-websearch> /providers stepfun,zhipu # 限制本会话使用的 provider
cn-websearch> /test stepfun            # 单独探测某一家
cn-websearch> /status  /config  /json on  /help  /quit
```

## 配置

三层合并,后者覆盖前者:

**内置默认值 → JSON 配置文件 → 环境变量**

环境变量优先级最高,因为 MCP 客户端通常只能传 `env`。

### 配置文件

在工作目录放 `cn-websearch.config.json` 即自动生效;或用 `WEBSEARCH_CONFIG=/path/to/file.json` 显式指定。

全部可用字段见 [cn-websearch.config.example.json](cn-websearch.config.example.json)。最小示例:

```json
{
  "strategy": "aggregate",
  "providers": {
    "stepfun": { "apiKey": "sk-...", "priority": 10 },
    "zhipu": { "priority": 5, "options": { "searchEngine": "search_pro" } },
    "kimi": { "enabled": false }
  }
}
```

若把 API key 写进该文件,**不要提交它**——`cn-websearch.config.json` 默认已被 git 忽略(若你的配置不含密钥、希望共享,可用 `git add -f` 强制加入)。

### 自定义 provider 优先级

两种等价写法,按以下顺序生效:

1. `order`(配置文件)或 `WEBSEARCH_ORDER`(环境变量)——显式列表,越靠前优先级越高:`["stepfun", "zhipu"]`。
2. 每个 provider 的 `priority`——数值越大越靠前;同值时按字母序,保证结果稳定可复现。
3. 都没设置 → 字母序默认(`kimi, mimo, stepfun, zhipu`)。

配置文件写法:

```json
{ "providers": { "stepfun": { "priority": 10 }, "zhipu": { "priority": 5 } } }
```

或环境变量:

```bash
WEBSEARCH_ORDER=stepfun,zhipu,kimi
STEPFUN_PRIORITY=10
```

命令行 `--providers` 只影响当次调用,不改变已配置的优先级。

### 设置项

| 配置文件 | 环境变量 | 默认值 | 含义 |
|---|---|---|---|
| `strategy` | `WEBSEARCH_STRATEGY` | `fallback` | `fallback` = 首个成功即返回;`aggregate` = 多源合并 |
| `order` | `WEBSEARCH_ORDER` | 字母序 | 显式优先级列表 |
| `count` | `WEBSEARCH_COUNT` | `8` | 工具调用未传 `count` 时的默认结果数 |
| `timeoutMs` | `WEBSEARCH_TIMEOUT_MS` | `30000` | 单次尝试预算;重试获得等额新预算,故单 provider 最坏约 2 倍 |
| `maxProviders` | `WEBSEARCH_MAX_PROVIDERS` | `4` | 单次调用最多使用几个 provider(链长/并发上限) |
| `dedupe` | `WEBSEARCH_DEDUPE` | `true` | 聚合时是否按 URL 去重 |
| — | `WEBSEARCH_CONFIG` | — | 显式指定配置文件路径 |

布尔值接受 `true/false`、`1/0`、`yes/no`、`on/off`。非法值只告警并回退,不会导致启动失败。

### 单个 provider 的设置

所有 provider 共用一组通用开关,配置文件或 `<NAME>_<SUFFIX>` 环境变量均可:

`apiKey`(`_API_KEY`)、`baseUrl`(`_BASE_URL`)、`model`(`_MODEL`)、`enabled`(`_ENABLED`)、`priority`(`_PRIORITY`)、`timeoutMs`(`_TIMEOUT_MS`,覆盖全局预算)、以及 provider 专属参数的 `options`:

| Provider | `options` | 说明 |
|---|---|---|
| `kimi` | `maxRounds`(1-5,默认 2)、`maxTokens`(256-32768,默认 8192) | Kimi 联网循环的轮数与 token 上限 |
| `mimo` | `location`(`country`/`region`/`city`,默认 `country`)、`maxKeyword`(1-10,默认 3)、`forceSearch`(默认 true) | |
| `stepfun` | `category` | 未设置则不发送该字段 |
| `zhipu` | `searchEngine`(默认 `search_std`)、`contentSize`(默认 `high`) | `searchEngine` 也可用 `ZHIPU_SEARCH_ENGINE` 设置 |

密钥永不落日志、永不回显:错误文本会先洗净疑似凭据的片段,状态输出只报告"是否已配置"。

## 工具

### `web_search`

入参:`{ "query": string, "count"?: integer, "strategy"?: "fallback"|"aggregate", "providers"?: string[] }`。

`count` 默认取配置值,`strategy` 默认取配置策略;显式传入的 `providers` 必须是已启用且配了 key 的 provider——否则返回带明确原因的结构化错误,而不是静默忽略。

输出:归一化结果 + 审计轨迹。聚合模式下每条结果带 `source`,`_meta.providers` 列出全部应答方:

```json
{
  "results": [
    {
      "title": "…",
      "url": "https://…",
      "snippet": "…",
      "content": "provider 返回全文时有值",
      "published_date": "2026-09-06",
      "source": "stepfun"
    }
  ],
  "_meta": {
    "provider": "stepfun",
    "providers": ["stepfun", "zhipu"],
    "total_latency_ms": 2586,
    "attempts": [
      { "provider": "stepfun", "status": "ok", "latency_ms": 2025 },
      { "provider": "zhipu", "status": "transient_error", "latency_ms": 611, "error": "HttpError: HTTP 429: …" }
    ]
  }
}
```

### `provider_status`

只读:生效的策略与设置,以及每个 provider 是否启用、是否配了 key、是否在活跃链中。

## 降级与失败语义

- 只有**已启用且配了 key** 的 provider 参与。`fallback` 按优先级依次尝试;`aggregate` 并行查询。
- 单次尝试:一个墙钟预算(`timeoutMs`);卡死的请求会被中止并记为 `timeout`。
- 瞬时错误(网络错误、HTTP 5xx、429、超时)重试 **1 次**,仍失败则切下一家。
- 永久错误(HTTP 4xx)不重试,立即切换。
- `aggregate` 下部分失败不算失败:成功者的结果照常返回,失败明细留在 `_meta.attempts`。
- 每次尝试都记录在 `_meta.attempts`——成功、重试、超时或报错。
- 全部失败时,`web_search` 返回包含完整尝试列表的结构化错误。

## Provider 支持矩阵

| Provider | 使用的通道 | 结构化结果 | 全文 |
|---|---|---|---|
| StepFun | `POST /v1/search` REST API | ✅ | ✅(`content`) |
| 智谱 GLM | `POST /api/paas/v4/web_search` 独立 API | ✅ | 摘要 |
| MiMo | OpenAI chat completions + `web_search` 工具 | 引用 | ✗(LLM 答案在 `_meta.answer`) |
| Kimi | chat "web-search formula" 4 步循环 | 引用 URL | ✗(LLM 答案在 `_meta.answer`) |

关于 Kimi/MiMo:这两家返回的是"LLM 综合答案 + 引用",不是纯结果列表。本 server 把引用转成结果条目,综合答案放在 `_meta.answer`(多源聚合时按 provider 标注)。

## 开发

```bash
npm install
npm run build          # tsc → dist/
npm test               # vitest,全部 HTTP mock(无需 key)
npm run test:coverage  # 覆盖率门槛:src/ 不低于 95%
npm run smoke          # 对每个就绪 provider 发真实请求,输出延迟表
npm run cli -- repl    # 用 tsx 从源码运行 CLI
```

### 约定

- **注释与 file header 用英文。**
- **运行时可见字符串保持英文**——tool 描述、CLI 输出、日志、错误消息——使客户端与脚本获得稳定、可 grep 的输出。
- `src/server-info.ts` 中的 `SERVER_NAME` / `SERVER_VERSION` 是服务器身份的唯一来源;`test/server-info.test.ts` 在每次测试运行时断言其与 `package.json` 一致。
- 分层单向依赖:最底层 `types` / `errors` / `config-file` / `normalize`,其上 `config` / `http`,再上 `orchestrator` / `probe`,再上 `providers`,最上层 `runtime` / `tools` / `cli`。`madge --circular` 为空。

## 协议

[MIT](LICENSE)
