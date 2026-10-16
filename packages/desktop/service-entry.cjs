// Do not initialize the backend until the host has assigned this process to its Job.
process.once('message', async (message) => {
  if (message?.type !== 'start') return;
  process.argv = [process.execPath, message.entry, ...message.args];
  try {
    if (message.loader) await import(require('node:url').pathToFileURL(message.loader).href);
    await import(require('node:url').pathToFileURL(message.entry).href);
  } catch (error) {
    console.error(error); process.exit(1);
  }
});
