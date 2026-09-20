# test/e2e/

端到端测试。与 [../](..) 中直接 import `src/`、对每个边界打桩的单元测试不同,这里的测试把构建产物 `dist/index.js` 作为真实子进程启动,并以外部消费方的方式与之交互:

- `mcp-stdio.test.ts` 通过 SDK 使用的 `Content-Length` 帧 JSON-RPC 2.0 驱动 MCP stdio server(initialize → tools/list → tools/call 往返)。
- `cli-process.test.ts` 运行一次性 CLI 命令,并断言退出码与输出。
- `config-priority.test.ts` 针对真实进程启动验证「默认值 → 配置文件 → 环境变量」的优先级。
- `build-artifact.test.ts` 直接检查编译后的入口产物。

## 共享基础设施

`_helpers.ts` 提供上述测试复用的一切:

- `cleanEnv()` —— 移除所有通道与网关变量的 env 映射,子进程因此绝不可能触达真实上游 API。
- `freshTempDir()` / `runCliInEphemeralCwd()` —— 在一次性临时目录中作为 cwd 运行二进制,避免项目根目录真实的 `.env` 经由进程内 dotenv 加载器渗入。
- `runCli()` / `spawnServer()` / `attachClient()` —— 子进程运行工具与一个极简 MCP stdio 客户端。

这些辅助函数绝不能携带真实 API key。真实网络验证位于 `scripts/smoke.ts`,通过 `npm run smoke` 运行,不属于 vitest。

由于测试针对的是 `dist/index.js`,在修改 `src/` 之后、`npm test` 之前请先 `npm run build`;否则子进程运行的是过期代码。
