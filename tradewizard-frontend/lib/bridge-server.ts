const BRIDGE_API_URL = process.env.BRIDGE_API_URL ?? "https://bridge.polymarket.com";

/**
 * Upstream calls are given a hard ceiling. Without it a stalled bridge request
 * leaves the deposit modal spinning until the browser gives up, and the route's
 * generic 502 hides whether the cause was DNS, TLS or a hung connection.
 */
const BRIDGE_TIMEOUT_MS = 12_000;

export class BridgeUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

/**
 * Human-readable cause, safe to return to the client.
 *
 * Node's fetch reports connection failures as a bare "fetch failed" and puts the
 * real reason (ENOTFOUND, ECONNREFUSED, certificate errors) in `cause`, so walk
 * the chain instead of reporting the wrapper.
 */
function describe(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      if (current.name === "TimeoutError" || current.name === "AbortError") {
        return "bridge request timed out";
      }
      const code = (current as NodeJS.ErrnoException).code;
      const text = current.message || current.name;
      parts.push(code && !text.startsWith(code) ? `${code}: ${text}` : text);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }

  return parts.join(" <- ") || "unknown error";
}

/**
 * Attach the optional builder code so Polymarket can attribute bridge traffic
 * to TradeWizard and prioritize stuck transfers.
 */
export function bridgeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const builderCode = process.env.POLYMARKET_BUILDER_CODE;
  if (builderCode) {
    headers["X-Builder-Code"] = builderCode;
  }

  return headers;
}

export async function bridgePost(
  path: string,
  payload: Record<string, unknown>
): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(`${BRIDGE_API_URL}${path}`, {
      method: "POST",
      headers: bridgeHeaders(),
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });

    return { status: response.status, body: await response.text() };
  } catch (error) {
    throw new BridgeUnavailableError(describe(error), error);
  }
}

export async function bridgeGet(
  path: string
): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(`${BRIDGE_API_URL}${path}`, {
      method: "GET",
      headers: bridgeHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });

    return { status: response.status, body: await response.text() };
  } catch (error) {
    throw new BridgeUnavailableError(describe(error), error);
  }
}
