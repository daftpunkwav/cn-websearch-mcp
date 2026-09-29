# test/

本包的 vitest 测试套件。所有内容通过 `npm test` 在 `vitest.config.ts` 下运行(单测上限 30 秒,因为端到端测试会启动真实子进程;单元测试本身毫秒级完成)。全部 HTTP 都被 mock——无需任何 API key,也不会接触真实上游。

## 结构

- `*.test.ts`(`test/` 根层级):单元与集成测试,每个被测模块一个文件,文件名镜像 `src/`:`src/config.ts` → `test/config.test.ts`,`src/orchestrator.ts` → `test/orchestrator.test.ts`,依此类推(`test/providers-index.test.ts` 覆盖 `src/providers/index.ts`;路径限定使它与覆盖 `src/index.ts` 的 `test/index.test.ts` 区分开)。这些测试直接 import `../src/...` 并注入替身(env 映射、`warn` 间谍、`fetchImpl` stub)——无网络、无磁盘。
- `upstream-contract.test.ts`:四个通道适配器的固化 fixture。它跨 `src/providers/*.ts` 而非镜像单个文件,因为它锁定的是每个第三方 API 各自拥有的线上契约——适配器构造的请求,以及它对一整份文档化响应体的映射。能否检出上游变更,见文件头说明。
- [e2e/](e2e/):端到端测试,把构建产物 `dist/index.js` 作为真实子进程启动,并使用 MCP stdio 帧协议或 CLI 协议进行交互。见 [e2e/README.zh.md](e2e/README.zh.md)。

## 类型检查

`npm run typecheck` 运行 `tsconfig.check.json`:它在构建配置之上扩展,覆盖 `src/`、`test/`、`scripts/` 与 `vitest.config.ts`。构建自身的 `tsconfig.json` 只从 `src/` 产出 `dist/`,而 vitest 转译时不做类型检查——没有这一步,测试或 smoke 脚本里的类型错误会一路混过 CI。共享基础配置开启了 `noUnusedLocals` / `noUnusedParameters`,因此一个死 import 或未使用的参数都会让检查失败。

## 覆盖率门槛

`npm run test:coverage` 对 `src/` 强制 lines / functions / branches / statements 四项均不低于 95%(`vitest.config.ts`)。`src/types.ts` 只有契约与策略词表、没有分支逻辑,自身即为 100%;`test/` 与 `scripts/` 位于被统计的树之外,因为 `include` 限定为 `src/**`。覆盖率跌破门槛会导致运行失败——应补充或扩展单元测试,而不是调低阈值。
