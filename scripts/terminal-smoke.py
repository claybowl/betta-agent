import os, pty, select, subprocess, tempfile, json, threading, time, shutil
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
root=str(Path(__file__).resolve().parents[1])
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  self.rfile.read(int(self.headers['Content-Length']))
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  chunks=[{'role':'assistant','tool_calls':[{'index':0,'id':'call_fixture','type':'function','function':{'name':'bash','arguments':json.dumps({'command':"printf 'READY_TO_STOP\\n'; sleep 15; touch SHOULD_NOT_EXIST"})}}]},{}]
  for i,delta in enumerate(chunks):
   data={'id':'fixture','object':'chat.completion.chunk','created':1,'model':'fixture','choices':[{'index':0,'delta':delta,'finish_reason':None if i==0 else 'tool_calls'}]}
   self.wfile.write(('data: '+json.dumps(data)+'\n\n').encode())
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
temp=tempfile.mkdtemp(prefix='donjon-terminal-');home=os.path.join(temp,'agent');proc=None
try:
 subprocess.run(['node','dist/cli.js','init',home,'Keyboard Test','ollama/fixture'],cwd=root,check=True,stdout=subprocess.DEVNULL)
 with open(os.path.join(home,'settings.json'),'w') as f: json.dump({'version':1,'maxTurns':50,'compaction':True,'timeoutSeconds':0,'permissions':{'shell':True,'files':False,'mcp':False},'connections':[]},f)
 master,slave=pty.openpty();env={**os.environ,'DONJON_CONFIG_DIR':os.path.join(temp,'app'),'OLLAMA_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','TERM':'xterm-256color'}
 proc=subprocess.Popen(['node','dist/cli.js','chat',home],cwd=root,env=env,stdin=slave,stdout=slave,stderr=slave);os.close(slave)
 output=b''
 def until(marker,seconds=15):
  global output
  deadline=time.monotonic()+seconds
  while time.monotonic()<deadline:
   if select.select([master],[],[],.2)[0]:
    chunk=os.read(master,65536);output+=chunk
    if marker in output:return
  raise AssertionError('Missing '+repr(marker)+'\n'+output.decode(errors='replace'))
 until('You › '.encode());output=b''
 os.write(master,b'Run the command\n');until(b'\r\nREADY_TO_STOP\r\n');output=b''
 os.write(master,b'\x1b');until(b'Turn stopped.');until('You › '.encode())
 assert not os.path.exists(os.path.join(home,'SHOULD_NOT_EXIST'))
 os.write(master,b'/exit\n')
 deadline=time.monotonic()+5
 while proc.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.05)[0]:
   try: output+=os.read(master,65536)
   except OSError: pass
 if proc.poll() is None: raise AssertionError('Process still active: '+repr(output))
 assert proc.returncode==0
 print('PASS: real PTY Escape cancelled the shell, prevented its later file effect, restored the prompt, and exited cleanly.')
finally:
 if proc and proc.poll() is None:proc.kill();proc.wait()
 server.shutdown();server.server_close();shutil.rmtree(temp)
