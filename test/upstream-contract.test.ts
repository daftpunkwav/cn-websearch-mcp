/**
 * @file test/upstream-contract
 * @description Frozen upstream contract fixtures for all four channel adapters.
 *
 * Responsibilities:
 * - Pin the exact wire request each adapter builds (path, headers, body, clamps)
 *   against the response shape its own source comment records
 * - Pin the full normalization of a complete, realistically-sized response body,
 *   not just the handful of fields a minimal happy-path object happens to carry
 * - Prove that a renamed top-level container fails loudly (ParseError) rather
 *   than degrading into an empty success, so a protocol break cannot masquerade
 *   as a healthy channel
 *
 * Why these exist: the four channels are third-party HTTP APIs we do not control.
 * When one silently changes shape, the failure surfaces as ParseError and, under
 * the aggregate strategy, as AllProvidersFailedError — a production outage with no
 * clue which upstream moved. These fixtures make the assumed contract executable.
 *
 * What these fixtures are NOT: recordings. No test in this repository may contact a
 * live upstream or embed a real key, so these bodies are reconstructed from the
 * documented response schemas cited in each adapter's header comment, with the
 * surrounding envelope fields a real response carries. They pin *our* half of the
 * contract — the request we build and the mapping we perform — and they make the
 * assumed response schema explicit and checkable. They cannot detect an upstream
 * change on their own; only a real captured body can, and capturing one requires a
 * key this suite must never have. See the handoff note on recording one during a
 * `npm run smoke` run.
 */

import { describe, expect, it } from 'vitest';
import createKimiProvider from '../src/providers/kimi.js';
import createMimoProvider from '../src/providers/mimo.js';
import createStepfunProvider from '../src/providers/stepfun.js';
import createZhipuProvider from '../src/providers/zhipu.js';
import type { ProviderConfig } from '../src/config.js';
import type { FetchLike, SearchContext } from '../src/types.js';

/** Synthetic key material; never a real credential. */
const SYNTHETIC_KEY = 'SYNTHETIC-CONTRACT-KEY-0000';
const BASE_CFG = { apiKey: SYNTHETIC_KEY, enabled: true, priority: 0 };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Record every request and answer with the next queued body. One place for all four
 * adapters so each contract test below can read the exact bytes the adapter sent.
 */
function scriptedFetch(bodies: unknown[]): {
  fetchImpl: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: init! });
    const next = bodies.shift();
    if (next === undefined) throw new Error('adapter sent more requests than the fixture scripts');
    return jsonResponse(next);
  };
  return { fetchImpl, calls };
}

const ctx = (fetchImpl: FetchLike): SearchContext => ({
  timeoutMs: 5_000,
  signal: new AbortController().signal,
  fetchImpl,
});

const sentBody = (
  call: { init: RequestInit },
): Record<string, unknown> => JSON.parse(call.init.body as string);
const sentHeaders = (
  call: { init: RequestInit },
): Record<string, string> => call.init.headers as Record<string, string>;

// ---------------------------------------------------------------------------
// kimi — POST /v1/chat/completions + POST /v1/formulas/.../fibers (multi-round)
// ---------------------------------------------------------------------------

/** Chat turn that answers with a tool call, carrying the thinking-mode field
 * K2.5/K2.6 requires back. */
const KIMI_TOOL_CALL_TURN = {
  id: 'chatcmpl-kimi-contract-01',
  object: 'chat.completion',
  created: 1_757_900_000,
  model: 'kimi-k3',
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: '',
        reasoning_content: '用户问的是最近的模型发布，需要检索后再回答。',
        tool_calls: [
          {
            id: 'call_kimi_contract_01',
            type: 'function',
            index: 0,
            function: { name: 'web_search', arguments: '{"query":"最近一周国内发布的大模型"}' },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 412, completion_tokens: 96, total_tokens: 508 },
};

/** Fiber result: the tool's plaintext references plus the encrypted payload fed
 * back as the tool turn. */
const KIMI_FIBER_RESULT = {
  code: 0,
  context: {
    encrypted_output:
      'gAAAAABmN9S2k7Qx1vJ0hL4pR8tW3yZ6bC5dE4fG3hI2jK1lM0nO9pQ8rS7tU6vW5xX4cC3bB2aA9zZ8yX7wV6uT5sR4qQ3pP2oO1nM0lK9jI8hG7fE6dC5bA4zZ3xW2vU1tS0rQ9',
    references: [
      'https://tech.example.com/2026/09/domestic-llm-report',
      { url: 'https://tech.example.com/2026/09/domestic-llm-report' },
      { title: '模型发布汇总', url: 'https://news.example.com/models/2026-09' },
      { url: 'https://forum.example.com/t/thread-88123' },
    ],
  },
};

/** Closing tool-less turn: the synthesized answer. */
const KIMI_FINAL_TURN = {
  id: 'chatcmpl-kimi-contract-02',
  object: 'chat.completion',
  created: 1_757_900_004,
  model: 'kimi-k3',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: '最近一周国内发布了多款新模型，详见下列来源。' },
    },
  ],
  usage: { prompt_tokens: 1_890, completion_tokens: 231, total_tokens: 2_121 },
};

describe('kimi upstream contract', () => {
  const cfg: ProviderConfig = { ...BASE_CFG, baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3' };
  // maxRounds=1 makes the documented sequence exactly three requests: the tool
  // call, the fiber, and the tool-less closing chat that forces the final answer.
  // With the default of 2 rounds a model that answers on the second turn instead
  // short-circuits, so the closing chat would never be exercised.
  const oneRound: ProviderConfig = { ...cfg, options: { maxRounds: 1 } };

  it('runs the documented four-step loop and normalizes the full response', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      KIMI_TOOL_CALL_TURN, KIMI_FIBER_RESULT, KIMI_FINAL_TURN,
    ]);
    const out = await createKimiProvider(oneRound).search({ query: '最近一周国内发布的大模型', count: 8 }, ctx(fetchImpl));

    // --- request half: three calls, in the documented order, with the documented paths.
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.moonshot.cn/v1/chat/completions',
      'https://api.moonshot.cn/v1/formulas/moonshot/web-search:latest/fibers',
      'https://api.moonshot.cn/v1/chat/completions',
    ]);
    for (const call of calls) expect(sentHeaders(call).Authorization).toBe(`Bearer ${SYNTHETIC_KEY}`);

    // Step 1 declares the web_search function tool; step 3 drops tools to force an answer.
    expect(sentBody(calls[0]!)).toEqual({
      model: 'kimi-k3',
      messages: [{ role: 'user', content: '最近一周国内发布的大模型' }],
      max_tokens: 8192,
      tools: [
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: '用于信息检索的网络搜索',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string', description: '要搜索的内容' } },
              required: ['query'],
            },
          },
        },
      ],
    });

    // Step 2 posts the tool name and the raw argument string to the formula fiber endpoint.
    expect(sentBody(calls[1]!)).toEqual({
      name: 'web_search',
      arguments: '{"query":"最近一周国内发布的大模型"}',
    });

    // Step 3 must pass reasoning_content back verbatim; that is a hard server-side
    // requirement of thinking mode, not an optimisation.
    const closing = sentBody(calls[2]!);
    expect(closing.tools).toBeUndefined();
    const assistantTurn = (closing.messages as Record<string, unknown>[])[1]!;
    expect(assistantTurn.reasoning_content).toBe(
      KIMI_TOOL_CALL_TURN.choices[0]!.message.reasoning_content,
    );
    expect(assistantTurn.tool_calls).toHaveLength(1);
    // The tool turn carries the fiber's encrypted_output, not its references.
    const toolTurn = (closing.messages as Record<string, unknown>[])[2]!;
    expect(toolTurn).toEqual({
      role: 'tool',
      content: KIMI_FIBER_RESULT.context.encrypted_output,
      tool_call_id: 'call_kimi_contract_01',
    });

    // --- response half: the whole of it, including the duplicate reference.
    expect(out._meta.provider).toBe('kimi');
    expect(out._meta.answer).toBe('最近一周国内发布了多款新模型，详见下列来源。');
    expect(out.results).toEqual([
      { title: 'tech.example.com', url: 'https://tech.example.com/2026/09/domestic-llm-report', snippet: '' },
      { title: 'news.example.com', url: 'https://news.example.com/models/2026-09', snippet: '' },
      { title: 'forum.example.com', url: 'https://forum.example.com/t/thread-88123', snippet: '' },
    ]);
  });

  it('fails loudly when the response envelope is renamed', async () => {
    // The documented container is `choices`. If an upstream release moves it, the
    // adapter must raise ParseError — an empty result set here would be reported
    // to the caller as a healthy channel that simply found nothing.
    const { choices: dropped, ...rest } = KIMI_TOOL_CALL_TURN;
    const { fetchImpl } = scriptedFetch([{ ...rest, output: KIMI_TOOL_CALL_TURN.choices }]);
    await expect(createKimiProvider(cfg).search({ query: 'q', count: 8 }, ctx(fetchImpl))).rejects.toMatchObject({
      name: 'ParseError',
    });
  });

  it('caps results at the requested count', async () => {
    const { fetchImpl } = scriptedFetch([KIMI_TOOL_CALL_TURN, KIMI_FIBER_RESULT, KIMI_FINAL_TURN]);
    const out = await createKimiProvider(oneRound).search({ query: 'q', count: 2 }, ctx(fetchImpl));
    expect(out.results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// mimo — chat-completions carrying a server-side web_search tool
// ---------------------------------------------------------------------------

/** Citation annotations arrive interleaved: a highlight can precede its citation. */
const MIMO_COMPLETION = {
  id: 'chatcmpl-mimo-contract-01',
  object: 'chat.completion',
  created: 1_757_900_100,
  model: 'mimo-v2.5',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '根据检索结果，国内近期发布了几款新模型。',
        reasoning_content: '',
        annotations: [
          { type: 'web_search_highlight', title: '本次发布覆盖推理与代码能力', url: 'https://tech.example.com/llm/2026-09' },
          { type: 'url_citation', title: '2026 年 9 月国产大模型发布综述', url: 'https://tech.example.com/llm/2026-09' },
          { type: 'url_citation', title: '开放平台更新日志', url: 'https://platform.example.com/changelog/2026-09' },
          { type: 'url_citation', title: '', url: 'docs.example.com/models' },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 388, completion_tokens: 142, total_tokens: 530 },
};

describe('mimo upstream contract', () => {
  const cfg: ProviderConfig = {
    ...BASE_CFG,
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.5',
    options: { maxKeyword: 4, forceSearch: true, location: { country: 'China', region: 'Beijing' } },
  };

  it('builds the documented request and normalizes the full annotation list', async () => {
    const { fetchImpl, calls } = scriptedFetch([MIMO_COMPLETION]);
    const out = await createMimoProvider(cfg).search({ query: '国内新模型', count: 8 }, ctx(fetchImpl));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
    expect(sentHeaders(calls[0]!).Authorization).toBe(`Bearer ${SYNTHETIC_KEY}`);

    // The whole request body, because every field here is a documented knob whose
    // name the upstream owns: `limit` is the nearest thing the channel has to
    // `count`, and that mapping is an assumption this fixture now records.
    expect(sentBody(calls[0]!)).toEqual({
      model: 'mimo-v2.5',
      messages: [{ role: 'user', content: '国内新模型' }],
      max_completion_tokens: 2048,
      stream: false,
      extra_body: { thinking: { type: 'disabled' } },
      tools: [
        {
          type: 'web_search',
          max_keyword: 4,
          force_search: true,
          limit: 8,
          user_location: { type: 'approximate', country: 'China', region: 'Beijing' },
        },
      ],
      tool_choice: 'auto',
    });

    expect(out._meta.provider).toBe('mimo');
    expect(out._meta.answer).toBe('根据检索结果，国内近期发布了几款新模型。');
    // The highlight arrived before its citation, so the title must replace the
    // hostname placeholder rather than be dropped as a duplicate.
    expect(out.results).toEqual([
      {
        title: '2026 年 9 月国产大模型发布综述',
        url: 'https://tech.example.com/llm/2026-09',
        snippet: '本次发布覆盖推理与代码能力',
      },
      { title: '开放平台更新日志', url: 'https://platform.example.com/changelog/2026-09', snippet: '' },
      { title: 'docs.example.com', url: 'https://docs.example.com/models', snippet: '' },
    ]);
  });

  it('fails loudly when the response envelope is renamed', async () => {
    const { choices: dropped, ...rest } = MIMO_COMPLETION;
    const { fetchImpl } = scriptedFetch([{ ...rest, data: MIMO_COMPLETION.choices }]);
    await expect(createMimoProvider(cfg).search({ query: 'q', count: 8 }, ctx(fetchImpl))).rejects.toMatchObject({
      name: 'ParseError',
    });
  });
});

// ---------------------------------------------------------------------------
// stepfun — POST {base}/v1/search
// ---------------------------------------------------------------------------

const STEPFUN_RESULT = {
  query: '国内新模型',
  results: [
    {
      url: 'https://tech.example.com/llm/2026-09',
      position: 1,
      title: '2026 年 9 月国产大模型发布综述',
      time: '2026-09-14T08:30:00+08:00',
      snippet: '综述整理了本月国内厂商发布的模型、版本与开放能力。',
      content:
        '（完整正文）本月共有多家厂商发布新版本模型，覆盖推理、代码与多模态方向。以下按厂商与发布时间顺序展开……',
    },
    {
      url: 'https://platform.example.com/changelog/2026-09',
      position: 2,
      title: '开放平台更新日志',
      time: '2026-09-13T19:05:00+08:00',
      snippet: '平台更新了向量检索与批量接口。',
      content: '（完整正文）本次更新涉及检索与批量接口的配额调整……',
    },
    {
      url: 'https://forum.example.com/t/thread-88123',
      position: 3,
      title: '讨论：新模型的评测表现',
      time: 1757800000,
      snippet: '社区对新模型的评测结果做了汇总。',
      content: '',
    },
  ],
};

describe('stepfun upstream contract', () => {
  const cfg: ProviderConfig = { ...BASE_CFG, baseUrl: 'https://api.stepfun.com' };

  it('builds the documented request and normalizes the full result list', async () => {
    const { fetchImpl, calls } = scriptedFetch([STEPFUN_RESULT]);
    const out = await createStepfunProvider(cfg).search({ query: '国内新模型', count: 8 }, ctx(fetchImpl));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.stepfun.com/v1/search');
    // The docs require an explicit charset on this endpoint.
    expect(sentHeaders(calls[0]!)).toEqual({
      Authorization: `Bearer ${SYNTHETIC_KEY}`,
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(sentBody(calls[0]!)).toEqual({ query: '国内新模型', n: 8 });

    expect(out._meta.provider).toBe('stepfun');
    // Every documented field is mapped: time may arrive as a unix-seconds number.
    expect(out.results).toEqual([
      {
        title: '2026 年 9 月国产大模型发布综述',
        url: 'https://tech.example.com/llm/2026-09',
        snippet: '综述整理了本月国内厂商发布的模型、版本与开放能力。',
        content: '（完整正文）本月共有多家厂商发布新版本模型，覆盖推理、代码与多模态方向。以下按厂商与发布时间顺序展开……',
        published_date: '2026-09-14T08:30:00+08:00',
      },
      {
        title: '开放平台更新日志',
        url: 'https://platform.example.com/changelog/2026-09',
        snippet: '平台更新了向量检索与批量接口。',
        content: '（完整正文）本次更新涉及检索与批量接口的配额调整……',
        published_date: '2026-09-13T19:05:00+08:00',
      },
      {
        title: '讨论：新模型的评测表现',
        url: 'https://forum.example.com/t/thread-88123',
        snippet: '社区对新模型的评测结果做了汇总。',
        published_date: '2025-09-13T21:46:40.000Z',
      },
    ]);
  });

  it('fails loudly when the result container is renamed', async () => {
    const { fetchImpl } = scriptedFetch([{ query: 'q', hits: STEPFUN_RESULT.results }]);
    await expect(createStepfunProvider(cfg).search({ query: 'q', count: 8 }, ctx(fetchImpl))).rejects.toMatchObject({
      name: 'ParseError',
    });
  });

  it('clamps n to the documented 1..20 range', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ results: [] }, { results: [] }]);
    const p = createStepfunProvider(cfg);
    await p.search({ query: 'q', count: 50 }, ctx(fetchImpl));
    await p.search({ query: 'q', count: 0 }, ctx(fetchImpl));
    expect(sentBody(calls[0]!).n).toBe(20);
    expect(sentBody(calls[1]!).n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// zhipu — POST {base}/api/paas/v4/web_search
// ---------------------------------------------------------------------------

const ZHIPU_RESULT = {
  id: '8f2c1d9e7b5a4c2f',
  created: 1_757_900_500,
  request_id: 'req_zhipu_contract_01',
  search_engine: 'search_std',
  search_intent: false,
  search_result: [
    {
      title: '北京天气预报',
      content: '北京今天晴转多云，最高气温 26℃，最低气温 14℃。风力 3-4 级。',
      link: 'https://weather.example.com/beijing',
      media: '示例气象网',
      icon: 'https://weather.example.com/favicon.ico',
      refer: 'ref_weather_01',
      publish_date: '2026-09-15',
    },
    {
      title: '北京天气历史数据查询',
      content: '可查询北京近十年的逐日气温与降水记录。',
      link: 'https://archive.example.com/climate/beijing',
      media: '示例气象网',
      refer: 'ref_weather_02',
      publish_date: '2026-09-14',
    },
  ],
};

describe('zhipu upstream contract', () => {
  const cfg: ProviderConfig = {
    ...BASE_CFG,
    baseUrl: 'https://open.bigmodel.cn',
    options: { searchEngine: 'search_pro', contentSize: 'medium' },
  };

  it('builds the documented request and normalizes the full result list', async () => {
    const { fetchImpl, calls } = scriptedFetch([ZHIPU_RESULT]);
    const out = await createZhipuProvider(cfg).search({ query: '北京天气', count: 8 }, ctx(fetchImpl));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://open.bigmodel.cn/api/paas/v4/web_search');
    expect(sentHeaders(calls[0]!).Authorization).toBe(`Bearer ${SYNTHETIC_KEY}`);
    // search_query is capped at 70 characters by the upstream, so the truncation
    // is a request-side contract, not a display nicety.
    expect(sentBody(calls[0]!)).toEqual({
      search_query: '北京天气',
      search_engine: 'search_pro',
      search_intent: false,
      count: 8,
      content_size: 'medium',
    });

    expect(out._meta.provider).toBe('zhipu');
    expect(out.results).toEqual([
      {
        title: '北京天气预报',
        url: 'https://weather.example.com/beijing',
        snippet: '北京今天晴转多云，最高气温 26℃，最低气温 14℃。风力 3-4 级。',
        content: '北京今天晴转多云，最高气温 26℃，最低气温 14℃。风力 3-4 级。',
        published_date: '2026-09-15',
      },
      {
        title: '北京天气历史数据查询',
        url: 'https://archive.example.com/climate/beijing',
        snippet: '可查询北京近十年的逐日气温与降水记录。',
        content: '可查询北京近十年的逐日气温与降水记录。',
        published_date: '2026-09-14',
      },
    ]);
  });

  it('fails loudly when the result container is renamed', async () => {
    const { search_result: dropped, ...rest } = ZHIPU_RESULT;
    const { fetchImpl } = scriptedFetch([{ ...rest, search_results: ZHIPU_RESULT.search_result }]);
    await expect(createZhipuProvider(cfg).search({ query: 'q', count: 8 }, ctx(fetchImpl))).rejects.toMatchObject({
      name: 'ParseError',
    });
  });

  it('truncates search_query to the documented 70 characters and clamps count to 50', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ search_result: [] }]);
    await createZhipuProvider(cfg).search({ query: '气'.repeat(120), count: 999 }, ctx(fetchImpl));
    const body = sentBody(calls[0]!) as { search_query: string; count: number };
    expect(body.search_query).toHaveLength(70);
    expect(body.count).toBe(50);
  });
});
