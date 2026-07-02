// MCP stdio server bundled with PocketClaude. Claude Code launches it via
// --mcp-config and calls its `approve` tool for every permission decision
// (--permission-prompt-tool mcp__ccperm__approve). The tool bridges the request
// to the PocketClaude server over HTTP, which asks the phone to allow/deny.
const http = require('http');
const PORT = process.env.CC_PORT || '3000';
const rl = require('readline').createInterface({ input: process.stdin });
const send = o => process.stdout.write(JSON.stringify(o) + '\n');

// Ask the PocketClaude server (which asks the web user). Resolves to a decision
// object. FAIL-CLOSED: if the server is unreachable or replies garbage, deny —
// an approval system that allows-on-failure isn't an approval system. A deny
// doesn't hang the agent; it just skips that tool call.
function askServer(toolName, input) {
  return new Promise(resolve => {
    // CC_SESSION identifies which spawn this MCP instance belongs to, so the
    // server can route the prompt to the right conversation (spawns run in parallel).
    const body = JSON.stringify({ tool_name: toolName, input, session: process.env.CC_SESSION || '' });
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/mcp-permission', method: 'POST',
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        'authorization': 'Bearer ' + (process.env.CC_TOKEN || ''),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ behavior: 'deny', message: '伺服器回應無法解析' }); } });
    });
    req.on('error', () => resolve({ behavior: 'deny', message: '無法連上 PocketClaude 伺服器' }));
    req.end(body);
  });
}

rl.on('line', async line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ccperm', version: '1.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'approve',
      description: 'Prompt the user to approve or deny a tool call.',
      inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, required: ['tool_name', 'input'] },
    }] } });
  } else if (method === 'tools/call') {
    const a = params.arguments || {};
    const decision = await askServer(a.tool_name, a.input);
    // allow ONLY on an explicit allow — an unexpected shape (401 error json,
    // missing behavior) must not fall through to approval
    const out = decision && decision.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: a.input }
      : { behavior: 'deny', message: (decision && decision.message) || '使用者拒絕了此操作' };
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
  } else if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
});
