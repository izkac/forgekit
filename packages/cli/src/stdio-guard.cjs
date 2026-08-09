function removeInjectedNodeOption(options, injectedOption) {
  if (options === injectedOption) return '';
  const prefix = `${injectedOption} `;
  return options.startsWith(prefix) ? options.slice(prefix.length) : options;
}

function installBrokenPipeGuard(stream = process.stdout, exit = process.exit.bind(process)) {
  stream.on('error', (err) => {
    if (err?.code === 'EPIPE') exit(0);
    else throw err;
  });
}

const injectedOption = process.env.FORGEKIT_STDIO_GUARD_OPTION;
if (injectedOption) {
  process.env.NODE_OPTIONS = removeInjectedNodeOption(
    process.env.NODE_OPTIONS ?? '',
    injectedOption,
  );
  delete process.env.FORGEKIT_STDIO_GUARD_OPTION;
  installBrokenPipeGuard();
}

module.exports = { installBrokenPipeGuard, removeInjectedNodeOption };
