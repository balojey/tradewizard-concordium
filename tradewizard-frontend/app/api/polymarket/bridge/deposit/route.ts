import { NextRequest, NextResponse } from "next/server";
import { bridgePost, BridgeUnavailableError } from "@/lib/bridge-server";

/**
 * Create Polymarket bridge deposit addresses for the user's trading wallet.
 * The bridge credits pUSD to the wallet after the deposit is converted.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { address?: string };

    if (!body?.address || !/^0x[a-fA-F0-9]{40}$/.test(body.address)) {
      return NextResponse.json(
        { error: "A valid wallet address is required" },
        { status: 400 }
      );
    }

    const { status, body: responseBody } = await bridgePost("/deposit", {
      address: body.address,
    });

    return new NextResponse(responseBody, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Distinguish "Polymarket did not answer" from "we broke": the modal shows
    // this string, so a generic message leaves the user with nothing to act on.
    if (error instanceof BridgeUnavailableError) {
      const timedOut = /timed out/i.test(error.message);
      console.error("Bridge deposit proxy unavailable:", error.message);
      return NextResponse.json(
        {
          error: timedOut
            ? "Polymarket's bridge timed out. Please retry in a moment."
            : "Could not reach Polymarket's bridge. Check your connection and retry.",
          code: timedOut ? "bridge_timeout" : "bridge_unreachable",
          detail: error.message,
        },
        { status: timedOut ? 504 : 502 }
      );
    }

    console.error("Bridge deposit proxy failed:", error);
    return NextResponse.json(
      { error: "Failed to create deposit addresses", code: "bridge_error" },
      { status: 502 }
    );
  }
}
