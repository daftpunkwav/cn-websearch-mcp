# test/

本包的 vitest 测试套件。所有内容通过 `npm test` 在 `vitest.config.ts` 下运行(单测上限 30 秒,因为端到端测试会启动真实子进程;单元测试本身毫秒级完成)。全部 HTTP 都被 mock——无需任何 API key,也不会接触真实上游。

## 结构

- `*.test.ts`(`test/` 根层级):单元与集成测试,每个被测模块一个文件,文件名镜像 `src/`:`src/config.ts` → `test/config.test.ts`,`src/orchestrator.ts` → `test/orchestrator.test.ts`,依此类推(`registry.test.ts` 覆盖 `src/providers/index.ts`)。这些测试直接 import `../src/...` 并注入替身(env 映射、`warn` 间谍、`fetchImpl` stub)——无网络、无磁盘。
- [e2e/](e2e/):端到端测试,把构建产物 `dist/index.js` 作为真实子进程启动,并使用 MCP stdio 帧协议或 CLI 协议进行交互。见 [e2e/README.zh.md](e2e/README.zh.md)。

## 覆盖率门槛

`npm run test:coverage` 对 `src/` 强制 lines / functions / branches / statements 四项均不低于 95%(`vitest.config.ts`)。`src/types.ts` 是纯类型模块、`scripts/` 是真实网络代码,二者不计入指标。覆盖率跌破门槛会导致运行失败——应补充或扩展单元测试,而不是调低阈值。
