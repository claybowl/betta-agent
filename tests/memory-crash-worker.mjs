import fs from 'node:fs/promises';
import path from 'node:path';
import {updateMemory} from '../dist/memfs.js';
const [home]=process.argv.slice(2);
const original=fs.rename;
fs.rename=async(...args)=>{await original(...args);if(String(args[1]).endsWith('memory-transaction.json'))process.kill(process.pid,'SIGKILL');};
await updateMemory(home,[{path:'projects/crash.md',content:'Applied once after recovery.',expectedHash:'missing'}],'Crash recovery learning','crash-multi-file',['message-source']);
