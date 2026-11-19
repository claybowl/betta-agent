import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { runAgent } from '../dist/harness.js';
const [home, phase, provider] = process.argv.slice(2);
const models = createModels();
const faux = fauxProvider({ provider, models: [{ id: 'test' }] });
models.setProvider(faux.provider);
faux.setResponses(phase === 'crash' ? [
  fauxAssistantMessage(fauxToolCall('memory_write', {path:'learned.md', content:'Remember the blue boat.\n', expectedHash:'missing'}), {stopReason:'toolUse'}),
  fauxAssistantMessage('Remembered.'),
] : [fauxAssistantMessage('Recovered and remembered.')]);
const result = await runAgent({home, prompt:'Remember the blue boat.', requestId:'crash-proof'}, event => {
  if (phase === 'crash' && event.type === 'memory') process.kill(process.pid, 'SIGKILL');
}, models);
console.log(JSON.stringify(result));
