import config from './tsdown.config.ts'

// Clean, registry-installed dependencies are used by build-release.mjs. Source
// maps are development artifacts, not part of the redistributable bundle.
export default config.map(entry => {
  if (entry.platform !== 'node') return { ...entry, sourcemap: false }
  // This concrete backend is private to our own Storage Context and is not in
  // the standard CLI's dependency closure. Bundle the official implementation;
  // shared Host service definitions (especially LLM's opaque request registry)
  // remain external and must resolve to the Host's actual modules.
  const privateBackend = '@deepseek-ai/dsh-storage-sqlite'
  return { ...entry, sourcemap: false, deps: {
    ...entry.deps,
    neverBundle: (specifier: string) => specifier !== privateBackend && entry.deps.neverBundle(specifier),
    alwaysBundle: (specifier: string) => specifier === privateBackend,
  } }
})
