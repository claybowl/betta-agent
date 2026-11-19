import { appendFileSync } from 'node:fs';

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url !== 'http://localhost:11434/v1/chat/completions') {
    throw new Error('Unexpected scripted provider URL: ' + request.url);
  }
  const body = await request.json();
  appendFileSync(process.env.COMPACT_REQUESTS, JSON.stringify(body) + '\n');
  const system = body.messages.find(message => message.role === 'system')?.content ?? '';
  const last = body.messages.at(-1);
  const recall = last.content === 'Find the original message';
  const summary = /summari[sz]/i.test(system) && !system.includes('Persistent memory revision');
  if (summary && process.env.COMPACT_CANCEL === '1') {
    return new Promise((_, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      process.kill(process.pid, 'SIGINT');
    });
  }
  const delta = recall
    ? { tool_calls: [{ index: 0, id: 'recall_fixture', type: 'function',
      function: { name: 'recall_search', arguments: '{"query":"lantern atlas sentinel"}' } }] }
    : { content: summary ? 'The conversation discussed a repeated inventory.' : 'Fixture reply.' };
  const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', model: 'test',
    choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n';
  return new Response(chunk({ role: 'assistant', ...delta }, null) +
    chunk({}, recall ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
};
