# YouTube description

---

TradeWizard — accountable autonomous trading. An AI agent that trades prediction markets, a verified human behind it, and an audit trail you don't have to trust us for.

Concordium Trusted Agents Hackathon, 2026.

**The problem.** Autonomous agents are already spending real money. Ours opens positions on Polymarket without anyone approving each trade. But the trades are on-chain while the accountability isn't — nobody on the other side can tell whether an identifiable human stands behind the agent or a rented bot.

**What we built.**

- **Identity.** The operator verifies once with a Concordium identity provider. Their agent is registered in the CIS-8004 registry, its Polymarket key is bound via CIS-8, and it carries the Verified by Concordium badge. Verification is a single unauthenticated HTTP GET — no SDK, no API key. The badge means *accountable*, not *endorsed*: Concordium has not reviewed our code or our results, and we say so in the product.
- **Audit.** Every six hours, the agent's decisions are hashed into a Merkle root that is pinned as metadata on the agent itself. A subscriber gets an inclusion proof for their own trade and recomputes the root against the on-chain value. Nothing per-trade is published, only the root.
- **Refusal as evidence.** The proof endpoint rebuilds the epoch and will not answer if the rebuild no longer reproduces the anchored root. Edit or delete a decision after anchoring and proofs stop being served — a rewritten history becomes detectable instead of invisible.

**How it's built.** TypeScript on AWS: CDK, Lambda, Aurora Serverless v2, DynamoDB, Next.js 16. The agent runs on Strands Agents SDK with Amazon Bedrock (Nebius Token Factory as an alternative provider). Concordium provides CIS-8004 identity plus CIS-8 cross-chain key binding; execution stays on Polygon, which is the "one agent, native to another chain" topology the registry documents.

**No keys in our infrastructure.** The registry service holds no keys: every write is a build → sign → submit flow. Our Lambdas compute, verify and stage; the account owner signs. We never custody a user's signing key, which is why the final step of the demo is the operator's wallet rather than our server.

**Status.** Identity and audit are implemented and tested (950 backend tests). Payments via x402 are designed and deliberately deferred. The last on-chain hop — mint, badge, one anchored epoch — needs the operator's testnet identity, and we say that plainly rather than papering over it.

**Links**

- Repository: https://github.com/balojey/tradewizard-concordium
- Integration assessment: `docs/concordium-integration-assessment.md`
- Spike results: `docs/concordium-spike.md`

**Chapters**

0:00 Accountability is missing from autonomous agents
0:30 What TradeWizard already runs
1:05 A verified human behind the agent
1:40 An audit trail that survives distrust
2:20 Where the build stands
2:40 Close
