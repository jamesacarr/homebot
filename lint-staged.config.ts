const typecheck = () => 'pnpm typecheck';

const config = {
  '*.{js,ts}': ['pnpm lint', typecheck],
};

export default config;
