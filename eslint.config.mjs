// ESLint flat config: Airbnb style guide (base + TypeScript) via
// eslint-config-airbnb-extended. The codebase is a non-React Node package, so
// only the base presets apply. Plugin registration objects must precede the
// rule presets: the presets reference these plugin namespaces but do not
// register them themselves.
//
// The overrides below are the deliberate deviations from the stock presets.
// Each exists because the rule, as shipped, is wrong for this package; the
// comment states why. Everything else is stock Airbnb.
import { fileURLToPath } from 'node:url';
import { configs, plugins } from 'eslint-config-airbnb-extended';
import globals from 'globals';

export default [
  {
    // Never lint build output, dependency trees, coverage reports or local
    // scratch space.
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'docs-local/**', 'NVIDIA Corporation/**'],
  },
  plugins.stylistic,
  plugins.importX,
  plugins.typescriptEslint,
  ...configs.base.recommended,
  ...configs.base.typescript,
  {
    // Type-aware rules resolve every linted TS file against the whole-tree
    // tsconfig (src/ + test/ + scripts/ + vitest.config.ts). The default
    // project service only sees tsconfig.json, whose include list is src/ alone.
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['tsconfig.check.json'],
        tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)),
      },
    },
  },
  {
    // Plain-Node .mjs tooling (config file, CI scripts) has no tsconfig of its
    // own but still runs on Node, so it needs the Node globals.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      // Restore upstream airbnb-base's max-len ignores (URLs, string and
      // template literals, regex literals). airbnb-extended ships the rule
      // bare, which fails long wire-format strings that cannot be wrapped.
      '@stylistic/max-len': ['error', 100, 2, {
        ignoreUrls: true,
        ignoreComments: false,
        ignoreRegExpLiterals: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
      }],
      // Same upstream fidelity: airbnb-base allows `void expr` in statement
      // position (discarding a floating promise intentionally); the bare
      // setting here rejects even that.
      'no-void': ['error', { allowAsStatement: true }],
      // The fallback orchestrator is a sequential engine by design: each
      // provider attempt carries its own timeout and the next attempt starts
      // only after the previous one settles. Parallelizing with Promise.all
      // would change the traffic contract, and for..of over an array is the
      // readable shape for that loop. Upstream's ban exists for
      // regenerator-runtime cost, which does not apply on Node >= 18. The
      // other upstream selectors (ForIn, labeled statements, `with`) stay.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ForInStatement',
          message: 'for..in loops iterate over the entire prototype chain, which is never what you want. Use Object.{keys,values,entries}, and iterate over the resulting array.',
        },
        {
          selector: 'LabeledStatement',
          message: 'Labels are a form of GOTO; using them makes code confusing and hard to maintain and understand.',
        },
        {
          selector: 'WithStatement',
          message: '`with` is disallowed in strict mode because it makes code impossible to predict and optimize.',
        },
      ],
      'no-await-in-loop': 'off',
      // Parser, dotenv and provider loops use `continue` to skip malformed
      // entries; inverting each site into nested ifs deepens nesting in the
      // exact places where flat control flow aids auditing. Loop-shape
      // deviations (this, no-await-in-loop, ForOf above) are the one
      // calibration this backend package makes to the guide.
      'no-continue': 'off',
      // The CLI renders through stdout/stderr and the stdio MCP server speaks
      // on the same streams; console is the transport here, not a stray debug
      // print. Stray debug output is caught in review, not by this rule.
      'no-console': 'off',
      // `_meta` is the MCP protocol's own wire-format field name; renaming it
      // would break the protocol surface. The other upstream options
      // (enforceInMethodNames) are kept at their stock values.
      'no-underscore-dangle': ['error', { allow: ['_meta'], enforceInMethodNames: true }],
      // Two deliberate colocated class families: the error taxonomy
      // (src/errors.ts) and the structured-failure classes next to the
      // orchestrator that throws them (src/orchestrator.ts). Each module is the
      // single responsibility; splitting 6-line classes into per-class files
      // would add import ceremony without a new boundary.
      'max-classes-per-file': ['error', { max: 4 }],
    },
  },
];
