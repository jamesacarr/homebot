// Entry point. Real wiring lands in a later step per plan.md.
// For now this just ensures the build/run pipeline works end-to-end.

const startupEvent = {
  event: 'startup',
  level: 'info',
  message: 'homebot scaffold',
  timestamp: new Date().toISOString(),
};

process.stdout.write(`${JSON.stringify(startupEvent)}\n`);
