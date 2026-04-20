const typecheck = () => 'pnpm typecheck';

// Invoke biome directly rather than `pnpm lint`, so only the staged files get
// formatted/linted. `pnpm lint` runs `biome check --write .` which operates on
// the whole repo and silently re-stages unrelated files into the commit.
const config = {
  '*.{js,ts}': ['biome check --write --no-errors-on-unmatched', typecheck],
};

export default config;
