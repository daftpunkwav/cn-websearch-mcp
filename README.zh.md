# cn-websearch-mcp

> 语言: **English** [README.md](README.md) | **简体中文**

**一个 MCP 工具,多条内置联网搜索通道。** 一个 [Model Context Protocol](https://modelcontextprotocol.io) server,把若干上游联网搜索 API 收敛在单个 `web_search` 工具之后。各通道的 wire 格式互不兼容——有的走 chat-completions 风格的 API,带服务端 tool-call 或 fiber 循环;有的是独立的搜索 REST 端点——本 server 把它们归一化为同一 schema,并提供两种策略:

- **`fallback`**(默认)——按**你的**优先级顺序依次尝试,第一个成功的即返回。请求少、延迟低。
- **`aggregate`**——并行查询多个通道,合并结果、按 URL 去重,并给每条结果标注来源通道。覆盖更广。

```
fallback:   kimi ──✓ 1.2s → 返回            aggregate:  kimi  ─┐
            stepfun (kimi 失败才试)                     stepfun ─┼─→ 合并去重 → 返回
            zhipu   (以上都失败才试)                     zhipu   ─┘
```

图中的通道标识(`kimi`、`stepfun`、`zhipu`、`mimo`)就是项目里的字面量配置 key,完整列表见[配置](#配置)。

## 安装

需要 Node >= 18。从源码:

```bash
npm install
npm run build     # tsc → dist/
```

至少提供一把通道 API key——环境变量、`.env` 文件或 JSON 配置文件都行(见[配置](#配置))。没配 key 的通道自动跳过。

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
cn-websearch-mcp status                # 生效配置 + 通道状态
cn-websearch-mcp test                  # 逐个探测就绪的通道
cn-websearch-mcp repl                  # 交互式会话
cn-websearch-mcp help                  # 完整用法
```

选项:`-n/--count <1-50>`、`--strategy fallback|aggregate`、`--providers a,b`(仅本次调用生效)、`--no-dedupe`、`-q/--query`(`test` 的查询词)、`--json`(原始输出,便于脚本消费)、`-h`、`-v`。

退出码:`0` 成功、`1` 运行失败(搜索失败/无可用通道)、`2` 用法错误——脚本与 CI 可据此分支。

交互式会话里,裸文本即搜索,`/` 命令控制会话:

```
cn-websearch> 一条最近新闻
cn-websearch> /strategy aggregate      # 本会话切到多源
cn-websearch> /aggregate rust async    # 一次性多源搜索
cn-websearch> /count 12
cn-websearch> /providers stepfun,zhipu # 限制本会话使用的通道
cn-websearch> /test stepfun            # 单独探测某一条通道
cn-websearch> /status  /config  /json on  /help  /quit
```

## 配置

三层合并,后者覆盖前者:

**内置默认值 → JSON 配置文件 → 环境变量**

环境变量优先级最高,因为 MCP 客户端通常只能传 `env`。

### 配置文件

在工作目录放 `cn-websearch.config.json` 即自动生效;或用 `WEBSEARCH_CONFIG=/path/to/file.json` 显式指定。

已填好各字段的示例见 [cn-websearch.config.example.json](cn-websearch.config.example.json);每槽位的 `baseUrl` 与 `timeoutMs` 在该文件中的写法与下文列出的顶层设置一致。超过 1 MiB 的文件会被告警拒绝——这远高于任何真实配置,而读取是同步的,否则一个携带超大文件的仓库会在被解析前无从阻止。

最小示例:

```json
{
  "strategy": "aggregate",
  "providers": {
    "stepfun": { "apiKey": "sk-...", "priority": 10 },
    "zhipu":   { "priority": 5, "options": { "searchEngine": "search_pro" } },
    "kimi":    { "enabled": false }
  }
}
```

若把 API key 写进该文件,**不要提交它**——`cn-websearch.config.json` 默认已被 git 忽略(若你的配置不含密钥、希望共享,可用 `git add -f` 强制加入)。

### 自定义通道优先级

三种等价写法,按以下顺序生效:

1. `order`(配置文件)或 `WEBSEARCH_ORDER`(环境变量)——显式列表,越靠前优先级越高:`["stepfun", "zhipu"]`。
2. 每个通道的 `priority`——数值越大越靠前;同值时按字母序,保证结果稳定可复现。
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
| `timeoutMs` | `WEBSEARCH_TIMEOUT_MS` | `30000` | 单次尝试预算;重试获得等额新预算,故单通道最坏约 2 倍再加一次退避。上限 600000 ms |
| `maxProviders` | `WEBSEARCH_MAX_PROVIDERS` | `4` | 单次调用最多使用几条通道(链长/并发上限) |
| `dedupe` | `WEBSEARCH_DEDUPE` | `true` | 聚合时是否按 URL 去重 |
| — | `WEBSEARCH_CONFIG` | — | 显式指定配置文件路径 |

布尔值接受 `true/false`、`1/0`、`yes/no`、`on/off`。非法值只告警并回退,不会导致启动失败。

任意一层的**空值**(`KIMI_API_KEY=`、`"baseUrl": ""`)都视为「未设置」,因此模板文件里的空占位不会遮蔽下一层的真实值(配置文件或内置默认值)。超过 600000 ms 的 `timeoutMs` 会被告警拒绝并回退——这样的时长已超出 32 位定时器范围,会被静默变成 1 ms。

工作目录下的 `.env` 只读取这些配置项:`WEBSEARCH_*` 全局变量、旧的 `ZHIPU_SEARCH_ENGINE`,以及每个通道槽位的 `<NAME>_API_KEY` / `_BASE_URL` / `_MODEL` / `_ENABLED` / `_PRIORITY` / `_TIMEOUT_MS`。其余变量名不会进入 `process.env`——工作目录未必可信,而 `NODE_OPTIONS` 这类变量在第一次搜索请求之前就会被 Node 运行时读取。如果被跳过的名字看起来像是上述配置项(例如 `OTHERVENDOR_API_KEY`),会告警提示,而不是静默失效。超过 64 KiB 的 `.env` 同样会被告警忽略而不读取:工作目录不可信这一点对体积同样成立,且静默丢弃看起来就像一个没配任何密钥的网关。

### 结果 URL

结果 URL 会被规整为 `http`/`https` 链接:裸主机补 `https://` 前缀,协议相对地址 `//host/path` 补上 scheme。解析后落到其它 scheme 的引用(`javascript:`、`data:`、`file:`、`mailto:` 等)会直接从结果列表中丢弃,而不是原样透传——客户端会把这些 URL 渲染成可点击链接。四个内置通道返回的都是普通网页,因此这条规则只对恶意或畸形的响应生效。被丢弃的条目会带走整行,因此一次调用返回的结果数可能少于你请求的 `count`。

### 单通道设置

每条通道都支持同一组通用开关,配置文件或 `<NAME>_<SUFFIX>` 环境变量均可:

`apiKey`(`_API_KEY`)、`baseUrl`(`_BASE_URL`)、`model`(`_MODEL`)、`enabled`(`_ENABLED`)、`priority`(`_PRIORITY`)、`timeoutMs`(`_TIMEOUT_MS`,覆盖全局预算)、以及通道专属参数的 `options`。四个内置通道槽位及各自识别的 `options` key:

| 槽位 | 通道类型 | 识别的 `options` |
|---|---|---|
| `kimi`    | chat-completions + 多轮 tool-call 循环 + 独立的 fiber 端点 | `maxRounds`(1-5,默认 2)、`maxTokens`(256-32768,默认 8192) |
| `mimo`    | chat-completions + 服务端 `web_search` 工具 | `location`(对象 `{country, region, city}`;见下文)、`maxKeyword`(1-10,默认 3)、`forceSearch`(默认 `true`) |
| `stepfun` | 独立搜索 REST 端点(`POST {base}/v1/search`) | `category`(未设置则不发送) |
| `zhipu`   | 独立联网搜索 API(`POST {base}/api/paas/v4/web_search`) | `searchEngine`(默认 `search_std`)、`contentSize`(默认 `high`);`searchEngine` 也可用 `ZHIPU_SEARCH_ENGINE` 设置 |

`kimi` 槽位的多轮循环最多 `maxRounds` 轮 tool-call;只有当最后一轮仍返回 tool call 时,才会追加一次不带工具的 chat 调用强制拿到答案。`maxTokens` 是每次 chat 调用的 token 上限。`mimo` 槽位发送一个服务端 `web_search` 工具,带 `maxKeyword` 与 `forceSearch` 开关,以及由配置的 `location` key 组装的近似 `user_location`(`country` 恒发送,未配置时默认 `China`;`region` 与 `city` 仅在显式配置时发送)。`stepfun` 与 `zhipu` 槽位都是直接的 REST 调用,`options` 与这两个 API 接受的请求字段一一对应。

密钥永不落日志、永不回显:错误文本会先洗净疑似凭据的片段,状态输出只报告"是否已配置"。若某个已配置 key 的槽位其 `baseUrl` 不是 `https`,启动时会给出告警——否则该 key 会以明文传输。

## 工具

### `web_search`

入参:`{ "query": string, "count"?: integer, "strategy"?: "fallback"|"aggregate", "providers"?: string[] }`。

`count` 默认取配置值,`strategy` 默认取配置策略;显式传入的 `providers` 必须是已启用且配了 key 的槽位——否则返回带明确原因的结构化错误,而不是静默忽略。`count` 被夹到 1-50、`query` 截到 400 字符,本接口与所有 CLI 命令一致。

输出:归一化结果 + 审计轨迹。聚合模式下每条结果带 `source`,`_meta.providers` 列出全部应答方:

```json
{
  "results": [
    {
      "title": "…",
      "url": "https://…",
      "snippet": "…",
      "content": "通道返回全文时有值",
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
      { "provider": "zhipu",   "status": "transient_error", "latency_ms": 611, "error": "HttpError: HTTP 429: …" }
    ]
  }
}
```

### `provider_status`

只读:生效的策略与设置,以及每个槽位是否启用、是否配了 key、是否在活跃链中。

## 降级与失败语义

- 只有**已启用且配了 key** 的通道参与。`fallback` 按优先级依次尝试;`aggregate` 并行查询。
- 单次尝试:一个墙钟预算(`timeoutMs`);卡死的请求会被中止并记为 `timeout`。
- 瞬时错误(网络错误、HTTP 5xx、429)重试 **1 次**(先退避 250 ms,429 退避 1 s),仍失败则切下一条通道;`timeout` 一律不重试——无论由编排层的预算定时器还是通道自己抛出,墙钟预算都已耗尽,重试只是把同一份用尽的预算再交给同一条通道。
- 永久错误(HTTP 4xx 非 429)不重试,立即切换。
- MCP 客户端取消请求时,搜索立即停止:在途尝试被中止、审计记录为 `cancelled`,不再继续走完剩余通道(取消不会被误报成「全部通道失败」)。
- `aggregate` 下部分失败不算失败:成功者的结果照常返回,失败明细留在 `_meta.attempts`。
- 每次尝试都记录在 `_meta.attempts`——成功、重试、超时、取消或报错。
- 全部失败时,`web_search` 返回包含完整尝试列表的结构化错误。
- 完全没有配置任何通道时,`web_search` 同样返回结构化错误而不是崩溃——这是全新安装的正常状态;由于从未发起过任何尝试,其中的尝试列表为空。
- 一整轮 fallback 的最坏耗时约为每通道 `2 × timeoutMs + 退避`,四个通道用默认预算时可达约 4 分钟;请按客户端的超时上限调整 `WEBSEARCH_TIMEOUT_MS` 或 `WEBSEARCH_MAX_PROVIDERS`。

## 通道矩阵

| 槽位 | 使用的通道 | 结构化字段 | 文本返回 |
|---|---|---|---|
| `kimi`    | chat-completions + 多轮 tool-call 循环 + `POST {base}/v1/formulas/moonshot/web-search:latest/fibers` | fiber 引用 URL | LLM 答案在 `_meta.answer` |
| `mimo`    | chat-completions + 服务端 `web_search` 工具 | `url_citation` + `web_search_highlight` 注解 | LLM 答案在 `_meta.answer` |
| `stepfun` | `POST {base}/v1/search` | title, time, snippet, content | 全文在 `content` |
| `zhipu`   | `POST {base}/api/paas/v4/web_search` | title, link, content, publish_date | 摘要放 `snippet`,全文放 `content` |

`kimi` 与 `mimo` 两个槽位返回的是"LLM 综合答案 + 引用",不是纯结果列表。本 server 把引用转成结果条目,综合答案放在 `_meta.answer`(多源聚合时按通道标注)。

## 开发

```bash
npm install
npm run build          # tsc → dist/
npm run typecheck      # 对 src/、test/、scripts/ 做类型检查(不产出)
npm test               # vitest,全部 HTTP mock(无需 key)
npm run test:coverage  # 覆盖率门槛:src/ 上 lines/functions/branches/statements 均不低于 95%
npm run smoke          # 对每个就绪通道发真实请求,输出延迟表
npm run cli -- repl    # 用 tsx 从源码运行 CLI
```

### 约定

- **注释与 file header 用英文。**
- **运行时可见字符串保持英文**——tool 描述、CLI 输出、日志、错误消息——使客户端与脚本获得稳定、可 grep 的输出。
- `src/server-info.ts` 中的 `SERVER_NAME` / `SERVER_VERSION` 是服务器身份的唯一来源;`test/server-info.test.ts` 在每次测试运行时断言其与 `package.json` 一致。
- 分层单向依赖:最底层 `types` / `errors` / `config-file` / `normalize`,其上 `config` / `http` / `provider-selection`,再上 `orchestrator` / `probe`,再上 `providers`,最上层 `runtime` / `tools` / `cli`。

## 仓库结构

| 路径 | 内容 |
|---|---|
| [src/](src/README.zh.md) | 全部运行时代码(TypeScript,ESM) |
| [src/cli/](src/cli/README.zh.md) | 终端界面:参数解析、一次性命令、交互会话 |
| [src/providers/](src/providers/README.zh.md) | 各通道适配器与适配器注册表 |
| [test/](test/README.zh.md) | Vitest 测试:单元测试与子进程端到端测试 |
| [scripts/](scripts/README.zh.md) | 真实网络工具(smoke 探测、MCP stdio 探测) |

编码代理的工作规则见 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)