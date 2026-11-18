import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export interface RecallEntry { id:string; requestId:string; sessionId:string; role:'user'|'assistant'; text:string; time:string }
export function redact(text:string) {
  for(const [key,value]of Object.entries(process.env))if(/TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(key)&&value&&value.length>=12)text=text.split(value).join('[REDACTED]');
  return text.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,'[REDACTED PRIVATE KEY]').replace(/\b(?:sk-proj-|sk-ant-|ghp_)[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b/g,'[REDACTED]');
}
export function recordRecall(home:string,requestId:string,sessionId:string,role:RecallEntry['role'],text:string) {
  const db=new DatabaseSync(path.join(home,'state','recall.sqlite'));
  try{db.exec('CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, requestId TEXT, sessionId TEXT, role TEXT, text TEXT, time TEXT)');db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?)').run(`${requestId}:${role}`,requestId,sessionId,role,redact(text).slice(0,128000),new Date().toISOString());}finally{db.close();}
}
export function recall(home:string,query='',limit=40):RecallEntry[] {
  const file=path.join(home,'state','recall.sqlite');if(!fs.existsSync(file))return [];
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const maxResults = Math.trunc(Math.max(1, Math.min(200, limit)));
    if (Number.isNaN(maxResults)) return [];
    const matches: RecallEntry[] = [];
    const rows = db.prepare('SELECT * FROM messages ORDER BY rowid DESC').iterate() as unknown as Iterable<RecallEntry>;
    for (const row of rows) {
      const text = terms.length ? row.text.toLowerCase() : "";
      if (!terms.every(term => text.includes(term))) continue;
      matches.push(row);
      if (matches.length === maxResults) break;
    }
    return matches.reverse();
  } finally {
    db.close();
  }
}
export function hasRecallSources(home:string,ids:string[]) {
  if(ids.length>200||new Set(ids).size!==ids.length)return false;
  if(!ids.length)return true;
  const file=path.join(home,'state','recall.sqlite');if(!fs.existsSync(file))return false;const db=new DatabaseSync(file,{readOnly:true});
  try{return ids.every(id=>Boolean(db.prepare('SELECT 1 FROM messages WHERE id=?').get(id)));}finally{db.close();}
}
