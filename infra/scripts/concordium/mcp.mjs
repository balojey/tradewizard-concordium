/**
 * Minimal client for Concordium's Agent Registry MCP service.
 *
 * The service holds no keys: every mutating tool is `build_*` and returns a
 * contract receive parameter the caller must sign and submit themselves.
 *
 * Transport: JSON-RPC 2.0 over POST /mcp. Stateless, no auth, rate-limited per IP.
 */

export const MCP_URL = process.env.CONCORDIUM_MCP_URL ?? 'https://agent-registry-mcp.concordium.com/mcp';
export const REST_URL = process.env.CONCORDIUM_REST_URL ?? 'https://agent-registry-mcp.concordium.com';
export const INDEXER_URL = process.env.CONCORDIUM_INDEXER_URL ?? 'https://agent-registry-indexer.concordium.com';

let nextId = 1;

/** Call one MCP tool and return its parsed JSON payload. */
export async function callTool(name, args = {}) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status} for tool ${name}`);
  const body = await res.json();
  if (body.error) throw new Error(`MCP error for ${name}: ${body.error.message}`);
  const text = body.result?.content?.[0]?.text;
  if (text === undefined) throw new Error(`MCP tool ${name} returned no content`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** List available tool names. */
export async function listTools() {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }),
  });
  const body = await res.json();
  return (body.result?.tools ?? []).map((t) => t.name);
}

/**
 * Verify a badge over the public REST door (no auth, no SDK).
 * This is the call a Lambda or Next.js route handler should use.
 *
 * @param {string} id badge token address (base58) or Concordium account address
 * @param {'testnet'|'mainnet'|'devnet'} [network] override only; normally resolved from the badge
 */
export async function checkBadge(id, network) {
  const qs = network ? `?network=${network}` : '';
  const res = await fetch(`${REST_URL}/v1/check-badge/${id}${qs}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`check-badge HTTP ${res.status} for ${id}`);
  return res.json();
}
