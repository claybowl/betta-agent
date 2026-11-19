import { once } from 'node:events';

const release = once(process.stdin, 'end');
process.stdin.resume();

globalThis.fetch = async (input, init) => {
  if (process.env.BETTA_TEST_NO_PROVIDER === '1') {
    const message = 'Unexpected provider call during recovery-status';
    console.error(message);
    throw new Error(message);
  }
  const request = new Request(input, init);
  if (request.url !== 'http://localhost:11434/v1/chat/completions') {
    throw new Error('Unexpected scripted provider URL: ' + request.url);
  }
  await release;
  const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', model: 'test',
    choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n';
  return new Response(chunk({ role: 'assistant', content: 'Recovered and remembered.' }, null) +
    chunk({}, 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
};
