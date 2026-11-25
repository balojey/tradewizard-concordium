TradeWizard — accountable autonomous trading.

An AI agent that trades prediction markets, a verified human behind it, and an audit trail you don't have to take our word for.

THE PROBLEM

Autonomous agents are already spending real money. Ours opens positions on Polymarket without anyone approving each trade. But the trades are on-chain while the accountability isn't. Nobody on the other side can tell whether an identifiable human stands behind the agent, or a rented bot with a nice interface.

WHAT WE BUILT

Identity. The operator verifies once with a Concordium identity provider. Their agent is registered in the agent registry, its Polymarket signing key is bound to that identity, and it carries the Verified by Concordium badge. Verification is a single unauthenticated HTTP request: no SDK, no API key. The badge means accountable, not endorsed. Concordium has not reviewed our code or our results, and the product says so.

Audit. Every epoch of decisions is hashed into a Merkle root that is pinned as metadata on the agent itself. A subscriber gets an inclusion proof for their own trade and recomputes the root against the value committed on chain. Nothing per-trade is published, only the root.

Refusal as evidence. The proof endpoint rebuilds the epoch and will not answer if the rebuild no longer reproduces the anchored root. Edit or delete a decision after anchoring and proofs stop being served, so a rewritten history becomes detectable instead of invisible.

HOW IT'S BUILT

TypeScript on AWS: CDK, Lambda, Aurora, DynamoDB, Next.js. The agent runs on the Strands Agents SDK with Amazon Bedrock, with Nebius Token Factory as an alternative provider. Concordium provides the identity registry and the cross-chain key binding; execution stays on Polygon.

NO KEYS IN OUR INFRASTRUCTURE

The registry service holds no keys. Every write is build, then sign, then submit. Our Lambdas compute, verify and stage; the account owner signs. We never custody a user's signing key, which is why the final step of registration is the operator's wallet rather than our server.

STATUS

Identity and audit are implemented and running on testnet. A registered agent carries a valid badge, two epochs of real market decisions are anchored on chain, and each one still reproduces its root. Payments over x402 are designed and deliberately deferred. The last on-chain hop needs the operator's testnet identity, and we say that plainly rather than papering over it.

CHAPTERS

0:00 Accountability is missing from autonomous agents
0:30 What TradeWizard already runs
1:05 A verified human behind the agent
1:40 An audit trail that survives distrust
2:20 Where the build stands
2:40 Close
