import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export function archiveSearch(home:string,query:string) {
 const file=path.join(home,'state','history.sqlite');if(!fs.existsSync(file))return [];
 const terms=query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0,12)||[];if(!terms.length)return [];
 const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT id,source,substr(text,1,1200) AS excerpt FROM documents WHERE documents MATCH ? ORDER BY rank LIMIT 12').all(terms.map(t=>'"'+t.replaceAll('"','""')+'"').join(' AND '));}finally{db.close();}
}
export function archiveRead(home:string,id:string) {
 const file=path.join(home,'state','history.sqlite');if(!fs.existsSync(file))return null;
 const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT id,source,text FROM documents WHERE id=? LIMIT 1').get(id)||null;}finally{db.close();}
}
