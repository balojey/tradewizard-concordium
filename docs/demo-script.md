# TradeWizard — demo script

For the Encode Club submission: one video, under three minutes. Plain spoken text
only — punctuation drives pacing. Recorded over a screen capture of the running
product.

## Before recording

1. Sign in to the product once, so your account (and `users` row) exists.
2. Attach the live demo agent to that account:

```bash
cd infra
set -a && source .env.dev && set +a
export DB_SECRET_ARN=tw-dev-concordium-db-credentials
export DB_HOST=$(aws rds describe-db-instances --db-instance-identifier tw-dev-concordium-postgres \
  --region us-east-1 --query "DBInstances[0].Endpoint.Address" --output text)

npx tsx scripts/concordium/seed-demo.ts --attach-email <the email you signed in with>
```

That repoints token 1224 and its anchored epoch at your account, so the panel
shows the live data instead of its empty state. Leave off `--decisions`: the
epoch now holds decisions the platform produced from live markets, not samples.

3. The epoch you will show was produced by the platform itself: three live Polymarket
   markets analysed by the 14-agent pipeline, each recorded as a `NO_TRADE`
   decision (consensus vs market probability differ by less than the edge
   threshold). Decision ids for the tamper beat:

   | Market | Decision |
   | --- | --- |
   | Jensen Huang / NVIDIA | `0b8b0e45-9637-475a-b265-97fe0b09b0a4` |
   | NVIDIA CEO by 2028 | `70fe3280-3538-4caf-bb90-76e5a80270f1` |
   | Yokohama bout | `dc0fd788-6fa3-47e2-86e5-f910e818c11c` |

## Shot list

| Beat | On screen |
| --- | --- |
| 0:00 problem | A Polymarket market page, then the portfolio with live positions |
| 0:30 what runs | The portfolio page: positions, the analysis that produced them |
| 1:05 identity | Scroll to the accountability panel: badge, agent token, Polymarket signer. Click **Re-verify** and let the registry answer |
| 1:20 card integrity | The "card bytes / match the pinned hash" row, then the public card URL in a browser tab |
| 1:40 audit | Expand the anchored epoch → three decisions, each showing its market, recommendation and edge → click one → the proof render (market, leaf, index, path, "matches the value on chain") |
| 2:05 tamper | Run `anchor-proof.ts perturb --decision 0b8b0e45-…`, click a different decision and back: the panel shows the `409` refusal. Then `--restore` |
| 2:20 where we are | The registration endpoints on screen (or the CLI), stating plainly what is signed by the owner |
| 2:40 close | Back to the portfolio, panel visible |

---

## Full version (≈ 2:50)

**(0:00) The problem**

An AI agent is trading with someone's money right now. It reads a market, decides, and places the order. No human approves each trade. That is the point of it.

But ask a simple question. Who is accountable for that decision?

The trades are on-chain. The accountability isn't. Anybody can deploy an agent, and nobody on the other side can tell whether a real, identifiable human stands behind it, or whether it's a rented bot with a nice interface.

**(0:30) What already runs**

TradeWizard is a prediction-market trading platform on Polymarket. Fourteen specialised agents analyse every market in parallel. A deterministic stage fuses their signals, because we don't want a language model deciding probabilities when arithmetic can. Then an autonomous portfolio manager places real positions under risk limits it cannot argue with.

And it already records why it acted. Every decision stores its action, its conviction, whether its thresholds were met, and when it declined, the reason it declined.

**(1:05) What we added**

So we took that agent and gave it two things.

First, a verified human behind it. The operator verifies once with a Concordium identity provider. Their agent is registered on-chain, its Polymarket key is bound to that identity, and it carries the Verified by Concordium badge.

Here it is being checked. One HTTP request, no SDK, no API key. The badge proves a real person is accountable and can be identified if something goes wrong. It does not mean Concordium reviewed our code. It means accountable, not endorsed. We say that in the interface too, because the distinction matters.

**(1:40) The audit trail**

Second, a record anyone can check.

Every six hours, the agent's decisions are hashed into a Merkle root, and only the root is written on chain, as metadata on the agent itself.

A subscriber asks for a proof of their own trade. They get a path, a root, and the value committed on chain, and they recompute it themselves. Nothing per trade is published. Only the root is.

And here is the part I'd point at. Edit one decision in the database, after it was anchored, and ask for the proof again.

The endpoint refuses. It won't serve a proof whose epoch no longer rebuilds to its anchored root. Deleting a row stops being a silent edit. It becomes a detectable event.

**(2:20) Where we are**

Minting and anchoring are authorised by the account owner, and our service holds no keys. That's deliberate. It means the last step is the operator's wallet, not our server, and it means the demo's final hop is still the operator's signature.

Payments are next, and we deliberately left them out of this window. We'd rather show two halves that hold up than three that don't.

**(2:40) Close**

The trades were always public. Now the responsibility for them is too.

TradeWizard. Verified humans, verified agents, and a record you don't have to take our word for.
