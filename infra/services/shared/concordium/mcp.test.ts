import { describe, expect, it } from 'vitest';
import { AgentRegistryError, createAgentRegistryClient } from './mcp';

/** Capture a rejection as an AgentRegistryError without narrowing gymnastics at the call site. */
async function captureError(promise: Promise<unknown>): Promise<AgentRegistryError> {
  try {
    await promise;
  } catch (error) {
    return error as AgentRegistryError;
  }
  throw new Error('expected the call to reject, but it resolved');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function toolResult(payload: unknown): Response {
  return jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
}

describe('createAgentRegistryClient', () => {
  it('sends a JSON-RPC tools/call envelope and merges the network', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const client = createAgentRegistryClient({
      network: 'testnet',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return toolResult({ ok: true });
      }) as unknown as typeof fetch,
    });

    await expect(client.callTool('contract_info')).resolves.toEqual({ ok: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/mcp');
    expect(calls[0].body).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'contract_info', arguments: { network: 'testnet' } },
    });
  });

  it('lets an explicit argument override the client network', async () => {
    let seen: any;
    const client = createAgentRegistryClient({
      network: 'testnet',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen = JSON.parse(String(init.body));
        return toolResult({});
      }) as unknown as typeof fetch,
    });

    await client.callTool('agent_of', { network: 'mainnet', token_id: 1 });
    expect(seen.params.arguments).toEqual({ network: 'mainnet', token_id: 1 });
  });

  it('returns a plain sentence tool answer without throwing', async () => {
    const client = createAgentRegistryClient({
      fetchImpl: (async () => jsonResponse({ result: { content: [{ type: 'text', text: 'agent not found' }] } })) as unknown as typeof fetch,
    });

    await expect(client.callTool('agent_of', { token_id: 999999 })).resolves.toBe('agent not found');
  });

  it('surfaces a JSON-RPC error as AgentRegistryError naming the tool', async () => {
    const client = createAgentRegistryClient({
      fetchImpl: (async () => jsonResponse({ error: { message: 'config error: missing `sender`' } })) as unknown as typeof fetch,
    });

    const error = await captureError(client.callTool('build_register'));
    expect(error).toBeInstanceOf(AgentRegistryError);
    expect(error.message).toContain('missing');
    expect(error.toolOrPath).toBe('build_register');
  });

  it('fails loudly when a tool returns no text content', async () => {
    const client = createAgentRegistryClient({
      fetchImpl: (async () => jsonResponse({ result: { content: [] } })) as unknown as typeof fetch,
    });

    await expect(client.callTool('network_status')).rejects.toBeInstanceOf(AgentRegistryError);
  });

  it('reports an HTTP failure with its status', async () => {
    const client = createAgentRegistryClient({
      fetchImpl: (async () => jsonResponse({}, 503)) as unknown as typeof fetch,
    });

    const error = await captureError(client.callTool('network_status'));
    expect(error).toBeInstanceOf(AgentRegistryError);
    expect(error.status).toBe(503);
  });

  it('checks a badge over the REST door and returns the verdict', async () => {
    const urls: string[] = [];
    const client = createAgentRegistryClient({
      restUrl: 'https://registry.example/',
      timeoutMs: 1000,
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        return jsonResponse({ token_address: 'JyP9X', badge_valid: true, issues: [] });
      }) as unknown as typeof fetch,
    });

    const verdict = await client.checkBadge('JyP9X');
    expect(verdict.badge_valid).toBe(true);
    // Trailing slash on the base URL must not double up, and the id is escaped.
    expect(urls[0]).toBe('https://registry.example/v1/check-badge/JyP9X');
  });

  it('lists tool names', async () => {
    const client = createAgentRegistryClient({
      fetchImpl: (async () =>
        jsonResponse({ result: { tools: [{ name: 'agent_of' }, { name: 'check_badge' }] } })) as unknown as typeof fetch,
    });

    await expect(client.listTools()).resolves.toEqual(['agent_of', 'check_badge']);
  });

  it('wraps a transport failure instead of leaking the raw error', async () => {
    const client = createAgentRegistryClient({
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });

    const error = await captureError(client.checkBadge('JyP9X'));
    expect(error).toBeInstanceOf(AgentRegistryError);
    expect(error.message).toContain('unreachable');
  });
});
