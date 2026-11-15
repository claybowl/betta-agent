// A fake Doer API for tests. It implements only the routes the Doer add-on calls and records every request.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
export const COMPANY = '11111111-1111-4111-8111-111111111111';
export const AGENT = '22222222-2222-4222-8222-222222222222';
export const OTHER_AGENT = '33333333-3333-4333-8333-333333333333';
// A fixture value, not a real credential. Long enough for the runtime's redaction rule (12+ characters).
export const KEY = 'fixture-doer-agent-key-0001';
export async function fakeDoer(t, state = {}) {
  Object.assign(state, { runs: [], runDetails: {}, approvals: [], approvalIssues: {}, inbox: [], checkoutConflict: false, costStatus: 201, ...state });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://x'), route = url.pathname.replace(/^\/api/, '');
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, route, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'Unauthorized' });
    const company = `/companies/${COMPANY}`;
    let m;
    if (req.method === 'GET' && route === `${company}/heartbeat-runs`) return send(200, state.runs.filter(r => !url.searchParams.get('agentId') || r.agentId === url.searchParams.get('agentId')));
    if (req.method === 'GET' && (m = route.match(/^\/heartbeat-runs\/([^/]+)$/))) { const run = state.runDetails[m[1]] || state.runs.find(r => r.id === m[1]); return run ? send(200, run) : send(404, { error: 'Heartbeat run not found' }); }
    if (req.method === 'GET' && route === `${company}/approvals`) return send(200, state.approvals.filter(a => !url.searchParams.get('status') || a.status === url.searchParams.get('status')));
    if (req.method === 'POST' && route === `${company}/approvals`) { const approval = { id: randomUUID(), companyId: COMPANY, status: 'pending', requestedByAgentId: AGENT, type: body.type, payload: body.payload }; state.approvals.push(approval); state.approvalIssues[approval.id] = (body.issueIds || []).map(id => ({ id })); return send(201, approval); }
    if ((m = route.match(/^\/approvals\/([^/]+)(\/[a-z-]+)?$/))) {
      const approval = state.approvals.find(a => a.id === m[1]); if (!approval) return send(404, { error: 'Approval not found' });
      if (req.method === 'GET' && !m[2]) return send(200, approval);
      if (req.method === 'GET' && m[2] === '/issues') return send(200, state.approvalIssues[approval.id] || []);
      if (req.method === 'POST' && m[2] === '/comments') return send(201, { id: randomUUID(), approvalId: approval.id, body: body.body });
      if (req.method === 'POST' && m[2] === '/resubmit') { if (approval.status !== 'revision_requested') return send(422, { error: 'Only revision requested approvals can be resubmitted' }); approval.status = 'pending'; if (body.payload) approval.payload = body.payload; return send(200, approval); }
      if (req.method === 'POST' && ['/approve', '/reject', '/request-revision'].includes(m[2])) return send(403, { error: 'Board access required' });
    }
    if (req.method === 'GET' && route === '/agents/me/inbox-lite') return send(200, state.inbox);
    if ((m = route.match(/^\/issues\/([^/]+)(\/[a-z-]+)?$/))) {
      if (req.method === 'GET' && m[2] === '/heartbeat-context') return send(200, { issue: { id: m[1], title: 'Fixture issue', status: 'todo' } });
      if (req.method === 'GET' && m[2] === '/comments') return send(200, [{ id: 'c1', body: 'First comment' }]);
      if (req.method === 'POST' && m[2] === '/checkout') return state.checkoutConflict ? send(409, { error: 'Issue is checked out by another agent' }) : send(200, { id: m[1], status: 'in_progress', assigneeAgentId: body.agentId });
      if (req.method === 'PATCH' && !m[2]) return send(200, { id: m[1], ...body });
      if (req.method === 'POST' && m[2] === '/comments') return send(201, { id: randomUUID(), body: body.body });
    }
    if (req.method === 'POST' && route === `${company}/cost-events`) return state.costStatus === 201 ? send(201, { id: randomUUID(), ...body }) : send(state.costStatus, { error: 'Cost service unavailable' });
    return send(404, { error: 'Not found' });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, requests, env: { DOER_API_URL: url, DOER_API_KEY: KEY, DOER_COMPANY_ID: COMPANY, DOER_AGENT_ID: AGENT } };
}
export const run = (id, status, extra = {}) => ({ id, companyId: COMPANY, agentId: AGENT, status, startedAt: new Date().toISOString(), ...extra });
