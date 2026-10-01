# providers/ agent rules

The adapter contract and slot matrix live in [README.md](README.md).

## Shape

- One adapter file per slot. Export `create<Name>Provider(cfg: ProviderConfig): SearchProvider`.
- Keep the slot name in one module-level constant. Use it for `name` and for `_meta.provider`. That string matches the config key in `KNOWN_PROVIDERS`.
- `search` builds the request and parses the response. Timeout, retry, fallback, aggregation, and cancellation stay in `orchestrator.ts`.
- Send HTTP through `postJson` in `http.ts`.
- Import only lower layers: `types`, `errors`, `normalize`, `http`, and `config` types. Never import `orchestrator`, `runtime`, `tools`, `cli`, or a sibling adapter.
- Read channel-specific options from `ProviderConfig.options` and clamp them in the adapter.
- The file header records the upstream endpoint, the request fields, the response fields, and the date they were checked.

## Result metadata

- Set `_meta.provider` to the slot-name constant.
- Set `_meta.answer` only when the channel synthesizes an answer.
- Set `attempts` to `[]` and `total_latency_ms` to `0`. `orchestrator.ts` writes the real attempt trail and latency.

## Registry

- `index.ts` is the only registry. `FACTORIES` maps every `ProviderName` to its factory. `buildProviders` instantiates adapters in configured order.
- Enabled checks and API-key checks stay in `runtime.ts`.
- Outside this directory, only `runtime.ts` imports `buildProviders`.

## Adding a provider

- Add the adapter file in this directory.
- Add one `FACTORIES` entry in `index.ts`.
- Add the name to `KNOWN_PROVIDERS` in `config.ts`. `ProviderName` is derived from that array.
- Add a `PROVIDER_DEFAULTS` entry in `config.ts` with neutral `baseUrl`, `model`, and `openAiCompatible`.
- `FACTORIES` and `PROVIDER_DEFAULTS` are `Record<ProviderName, …>`. A missing entry fails the build.
- `<NAME>_*` environment variables are derived from the provider name. Do not add a parser branch for them.
- `baseUrl` normalization stays in `config.ts`: `ensureV1` for OpenAI-compatible slots, slash trimming otherwise.
