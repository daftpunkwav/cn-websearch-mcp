# scripts/

针对真实网络运行的工具脚本。它们被排除在 vitest 套件与覆盖率统计之外(`vitest.config.ts`)——测试从不触达真实上游,而这些脚本正是为此而存在。

| 文件 | 职责 |
|---|---|
| `smoke.ts` | 真实网络 smoke 探测(`npm run smoke`)。加载 `.env`、装配 runtime、用固定查询词对每个就绪通道探测一次(`SMOKE_QUERY` 可覆盖)、输出 markdown 延迟表,然后按当前策略跑一次完整搜索。至少需要一枚真实 API key;绝不打印密钥。 |
| `mcp-probe.mjs` | 手工 MCP stdio 调试辅助:启动 `dist/index.js`、发送一帧 `initialize` 请求,并报告子进程是否读到 stdin。用于诊断传输/启动问题,不属于任何自动化门禁。 |

`mcp-probe.mjs` 启动的是 `dist/index.js`,需先 `npm run build`;`smoke.ts` 经 tsx 直接从源码运行,无需构建。
