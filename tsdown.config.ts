const ID = '@local/workflow-agent-signal-lab'

const shared = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

export default [
  {
    name: ID,
    entry: {
      index: 'src/index.ts',
      'workflow-journal': 'src/workflow-journal.ts',
      'workflow-runtime': 'src/host/workflow-runtime.ts',
      'workflow-control': 'src/host/workflow-control.ts',
      'workflow-preset': 'src/host/workflow-preset.ts',
      'workflow-pwsh': 'src/host/workflow-pwsh.ts',
      'workflow-source': 'src/client/workflow-source.ts',
      'workflow-display': 'src/client/workflow-display.ts',
      'workflow-native-seats': 'src/client/workflow-native-seats.ts',
      'workflow-requirements-gate': 'src/client/requirements-gate-contract.ts',
      'workflow-manual-recovery-gate': 'src/client/manual-recovery-gate-contract.ts',
      'workflow-budget-gate': 'src/client/budget-gate-contract.ts',
      'workflow-budget-recovery': 'src/workflow-budget-recovery.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/') || specifier === 'zod' },
  },
  {
    // A fresh, self-contained Host entry also supports official config-only
    // HMR from the earlier Journal-only entry. Do not reuse cached internal
    // multi-entry ESM modules from the running slice-2 Host.
    name: `${ID}/workflow-engine`,
    entry: { 'workflow-engine': 'src/host/workflow-engine.ts' },
    outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, dts: false, clean: false,
    deps: { neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/') || specifier === 'zod' },
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/runtime.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => shared.has(specifier),
      alwaysBundle: (specifier: string) => !shared.has(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
