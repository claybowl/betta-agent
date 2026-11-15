// Runs one heartbeat the way Doer's process adapter would: Doer variables in the environment, no request id.
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { runAgent } from '../dist/harness.js';
const [home, phase, ...replies] = process.argv.slice(2);
const models = createModels();
const faux = fauxProvider({ models: [{ id: 'test' }] });
models.setProvider(faux.provider);
faux.setResponses(phase === 'crash' ? [
  fauxAssistantMessage(fauxToolCall('memory_write', { path: 'learned.md', content: 'Remember the blue boat.\n', expectedHash: 'missing' }), { stopReason: 'toolUse' }),
  fauxAssistantMessage('Remembered.'),
] : replies.map(text => fauxAssistantMessage(text)));
const events = [];
const result = await runAgent({ home, prompt: 'Heartbeat' }, event => {
  if (event.type === 'doer' || event.type === 'recovery') events.push(event);
  if (phase === 'crash' && event.type === 'memory') process.kill(process.pid, 'SIGKILL');
}, models);
console.log(JSON.stringify({ result, events, calls: faux.state.callCount }));
