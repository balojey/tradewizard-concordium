/**
 * Client for Concordium's Agent Registry service.
 *
 * The registry is a pair of smart contracts (CIS-8004 agent NFTs, CIS-8 external
 * keys) fronted by two HTTP surfaces:
 *
 *  - MCP (`POST /mcp`, JSON-RPC 2.0) — every registry operation as a tool.
 *    Read tools return chain state; **write tools are `build_*` and return a
 *    sign-ready contract payload**, because the service holds no keys. Signing
 *    and submission are the caller's job (see `infra/scripts/concordium`).
 *  - REST (`GET /v1/...`) — the public verification door. CORS open, no auth,
 *    rate-limited per IP. This is what runtime code should use to check a badge:
 *    it needs no SDK and no secret.
 *
 * Both are stateless, so this module is safe to use per-invocation from a Lambda.
 */

export type ConcordiumNetwork = 'devnet' | 'testnet' | 'mainnet';

export const AGENT_REGISTRY_MCP_URL =
  process.env.CONCORDIUM_MCP_URL ?? 'https://agent-registry-mcp.concordium.com/mcp';
export const AGENT_REGISTRY_REST_URL =
  process.env.CONCORDIUM_REST_URL ?? 'https://agent-registry-mcp.concordium.com';

/** Default network for this deployment. Testnet is where the hackathon lives. */
export const DEFAULT_CONCORDIUM_NETWORK: ConcordiumNetwork =
  (process.env.CONCORDIUM_NETWORK as ConcordiumNetwork | undefined) ?? 'testnet';

/**
 * Verification is a network call made on a user's behalf, so it must never hang
 * a request. Matches the Lambda default timeout headroom rather than exceeding it.
 */
const DEFAULT_TIMEOUT_MS = 8000;

export class AgentRegistryError extends Error {
  constructor(
    message: string,
    readonly toolOrPath?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AgentRegistryError';
  }
}

export interface AgentRegistryClientOptions {
  mcpUrl?: string;
  restUrl?: string;
  network?: ConcordiumNetwork;
  timeoutMs?: number;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface AgentRegistryClient {
  readonly network: ConcordiumNetwork;
  /** Call one MCP tool and return its parsed JSON result. */
  callTool<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Tool names the service currently exposes. */
  listTools(): Promise<string[]>;
  /** Full badge verdict over the public REST door. */
  checkBadge(idOrAccount: string): Promise<BadgeVerdict>;
}

/** A single check in a badge verdict. Mirrors the service's own vocabulary. */
export interface BadgeIssue {
  severity: 'error' | 'warning' | string;
  field: string;
  message: string;
}

/**
 * Verdict shape observed from `GET /v1/check-badge/{id}`. Fields are optional
 * because the service evolves them; consumers must fail closed, not throw.
 */
export interface BadgeVerdict {
  network?: string;
  token_id?: number;
  token_address?: string;
  agent_uri?: string;
  http_status?: number;
  card_sha256?: string;
  on_chain?: {
    owner_account?: string;
    status?: string;
    agent_uri?: string;
    metadata_hash_hex?: string;
  };
  checks?: Record<string, boolean | string | undefined>;
  badge_valid?: boolean;
  issues?: BadgeIssue[];
  summary?: { valid?: number; invalid?: number };
  agent_count?: number;
}

/**
 * Extraction of the MCP tool payload. A tool may return either a JSON document
 * or a bare string; anything else is a protocol change we want to notice loudly
 * rather than silently treat as empty.
 */
function unwrapToolResult<T>(name: string, result: unknown): T {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  const text = Array.isArray(content) ? content.find((c) => typeof c?.text === 'string')?.text : undefined;
  if (text === undefined) {
    throw new AgentRegistryError(`Agent registry tool ${name} returned no text content`, name);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // A few tools answer with a plain sentence (e.g. "not found"); keep it usable.
    return text as unknown as T;
  }
}

export function createAgentRegistryClient(options: AgentRegistryClientOptions = {}): AgentRegistryClient {
  const mcpUrl = options.mcpUrl ?? AGENT_REGISTRY_MCP_URL;
  const restUrl = (options.restUrl ?? AGENT_REGISTRY_REST_URL).replace(/\/+$/, '');
  const network = options.network ?? DEFAULT_CONCORDIUM_NETWORK;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let nextId = 1;

  async function post(body: unknown, path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(mcpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new AgentRegistryError(
        `Agent registry unreachable: ${error instanceof Error ? error.message : String(error)}`,
        path,
      );
    }
    if (!response.ok) throw new AgentRegistryError(`Agent registry HTTP ${response.status}`, path, response.status);
    return response.json();
  }

  return {
    network,

    async callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const payload = (await post(
        { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: { network, ...args } } },
        name,
      )) as { result?: unknown; error?: { message?: string } };
      if (payload.error) throw new AgentRegistryError(payload.error.message ?? 'unknown MCP error', name);
      return unwrapToolResult<T>(name, payload.result);
    },

    async listTools(): Promise<string[]> {
      const payload = (await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, 'tools/list')) as {
        result?: { tools?: Array<{ name: string }> };
      };
      return (payload.result?.tools ?? []).map((tool) => tool.name);
    },

    async checkBadge(idOrAccount: string): Promise<BadgeVerdict> {
      const path = `/v1/check-badge/${encodeURIComponent(idOrAccount)}`;
      let response: Response;
      try {
        response = await fetchImpl(`${restUrl}${path}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new AgentRegistryError(
          `Badge check unreachable: ${error instanceof Error ? error.message : String(error)}`,
          path,
        );
      }
      if (!response.ok) throw new AgentRegistryError(`Badge check HTTP ${response.status}`, path, response.status);
      return (await response.json()) as BadgeVerdict;
    },
  };
}
