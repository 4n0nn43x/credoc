# DocumentaryCredit.sol security review

Target: `contracts/src/DocumentaryCredit.sol` (509 lines, solc 0.8.30, OZ 5.4.0), Arc mainnet (chainId 5042).
Reviewer did not modify the repo. PoCs live in `review/proj/test/` (copy of the project):

- `PoC.t.sol` (unit, mock registry): H-1, M-2, L-1
- `PoCGas.t.sol` (unit): M-1
- `PoCFork.t.sol`, `PoCSummary.t.sol` (Arc mainnet fork, real ERC-8004 registries, mock token): I-1 measurements, L-3

Run: `cd review/proj && forge test --match-contract PoC -vv` and `forge test --match-contract 'PoCFork|PoCSummary' --fork-url https://rpc.mainnet.arc.io -vv`.
All existing repo tests pass (25 passed, 4 fork tests skipped under stock forge).

On-chain facts checked by RPC: both ERC-8004 registries are ERC-1967/UUPS proxies (reputation impl `0x16e0fa7f...da34`, identity impl `0x7274e874...9c02`), both `owner()` = `0x547289319C3e6aedB179C0b8e8aF0B5ACd062603`. Block gas limit is 30,000,000. USDC at `0x3600...` has code and exposes `isBlacklisted(address)`.

---

## High

### H-1 Applicant and seller can shorten expiry right before a sale and rug the financier's escrowed price
Lines 350-367 (`amendExpiry`), 413-431 (`acceptOffer`), 102-109 (`Offer` binds only `forOutstanding`).

An offer is only protected against outstanding changing. It is not protected against the expiry changing. The seller is still the payee until `acceptOffer` runs, so it can co-sign an amendment that shortens expiry.

Scenario. A financier does diligence on a credit: 100k outstanding, 90 days to expiry, and a reputable inspector as attestor. It offers 95k. Applicant and beneficiary collude in one block:
1. beneficiary `amendExpiry(id, now+1)`
2. applicant `amendExpiry(id, now+1)`, which applies it
3. beneficiary `acceptOffer(off)` and receives 95k

One second later the honest inspector can no longer present (`Expired`). Anyone calls `reclaim`, and the applicant gets the full 100k back. The financier loses 95k and had no window to react. The reputable attestor it relied on is defeated by the timing alone.

PoC: `test_PoC_expiryShortenRugsFinancier` PASS (importer fully refunded, exporter +95k, financier -95k).

Fix (minimal): only allow extensions: `if (newExpiry <= c.expiry) revert BadParams();` in `amendExpiry`. A real UCP amendment that shortens expiry is rare and not needed here. Defense in depth: add `uint64 minExpiry` to `Offer` (set by the financier or snapshotted from `c.expiry` in `makeOffer`) and require `c.expiry >= o.minExpiry` in `acceptOffer`.

---

## Medium

### M-1 `try/catch` does not protect settlement from registry gas exhaustion; the registries are upgradeable
Lines 465-476 (`_feedback`), 322-324 (three calls per settlement), 336.

`try reputationRegistry.giveFeedback(...)` forwards 63/64 of the remaining gas. If the registry consumes all of it (an out-of-gas loop, an `INVALID` opcode, or a future implementation whose cost grows), each failed call leaves only 1/64 of the gas. With 2 or 3 calls in `_maybeSettle`, the transaction needs about 64^2 to 64^3 times the tail cost, which is far above the 30M block gas limit. Settlement then becomes impossible for every credit that has a linked agent. The beneficiary who shipped cannot be paid, and after expiry the funds go back to the applicant. The NatSpec "Never reverts ... must not block money movement" is therefore false. Both registries are UUPS proxies controlled by a single owner (`0x5472...2603`), so this is a live third-party dependency on the money path.

PoC: `test_PoC_registryGasBurnBlocksSettlement` PASS: `present` reverts even with 30M gas.

Fix: cap the gas and refuse to run when the cap cannot be honoured:
```solidity
uint256 constant FEEDBACK_GAS = 300_000; // live cost measured ~130k
if (gasleft() < FEEDBACK_GAS * 64 / 63 + 20_000) revert(); // also kills the 63/64 skip trick (I-1)
try reputationRegistry.giveFeedback{gas: FEEDBACK_GAS}(...) {} catch { emit ReputationSkipped(...); }
```
Alternative: take reputation off the money path entirely, with a permissionless `recordFeedback(id, tranche)` guarded by a per-tranche "recorded" flag.

### M-2 Reputation is trivially wash-tradable and negative entries are avoidable, while README/SDK call it "unforgeable" and price forfaiting from it
Lines 37-38 (claim), 250-255 (`linkBeneficiaryAgent` re-linkable), 282-288 (`waive`), 322-324, 336, 341-346 (`cancel` writes nothing). SDK `quoteForfaiting` / `reputation()`, README line 24.

- **Wash trading at no capital cost.** One person controls the importer and exporter addresses. The attestor can be any address (even `0xdead`), because the applicant can `waive` every document. In a loop they `open` 1M, `linkBeneficiaryAgent`, `waive`, and send the 1M back. Each iteration writes "delivered" 100 plus two "volume" entries, so the only cost is gas. One 8-tranche credit gives 8 "delivered" entries. `quoteForfaiting` saturates trust at 20 deliveries, so 3 transactions buy the minimum risk premium. That feeds directly into H-1.
- **Dodging "expired".** Before expiry the beneficiary re-links a throwaway agent it owns (`linkBeneficiaryAgent` can be called again at any time), or, while it is still the payee, calls `cancel`, which writes no feedback at all.

PoC: `test_PoC_washTradeReputation` (60 entries from 20 round trips of the same 1M), `test_PoC_dodgeExpiredFeedback` (negative entry lands on the throwaway agent 9). Both PASS.

Fix: (a) allow `beneficiaryAgent` to be set once (`if (c.beneficiaryAgent != 0) revert`). (b) write a negative entry on `cancel` as well. (c) tag waived settlements differently (for example "delivered-waived"), or only count tranches whose documents were all presented by attestors. (d) drop the word "unforgeable" from the README, SDK and NatSpec. Sybil wash trading cannot be fixed on-chain, so state that consumers must weigh counterparty diversity and attestor identity.

---

## Low

### L-1 Stale expiry proposals never lapse and can revive an expired credit
Lines 350-367. `amendExpiry` has no `block.timestamp <= c.expiry` check, and proposals have no deadline. If the applicant offered an extension long ago and was ignored, the payee can accept it after expiry, provided nobody has called `reclaim` yet. The credit is then revived, a late presentation is accepted, and the applicant pays when it expected a refund. The only way to withdraw a proposal is to overwrite it.
PoC: `test_PoC_staleProposalRevivesExpiredCredit` PASS.
Fix: `if (block.timestamp > c.expiry) revert Expired();` in `amendExpiry`. Optionally store a proposal timestamp and reject proposals older than N days.

### L-2 A blocklisted payee can still redirect future proceeds via `acceptOffer`
Line 429. The sale price goes through `_pay`, so if the seller is blocklisted the price is just parked in `owed` and the assignment still succeeds. Arc's blocklist acts on USDC transfers, not on `msg.sender` of contract calls. A blocklisted payee (or a smart wallet relayed by an unblocked key) can therefore sell the receivable for 1 unit to an unblocked accomplice. The accomplice then receives every future settlement, so a sanctioned party moves value to a clean address. A Circle reviewer will notice this.
Fix: pay the seller with `c.token.safeTransfer(seller, o.price)` in `acceptOffer`, so a blocked seller cannot assign. The same class of issue exists for `waive` by a blocklisted applicant. That is a generic escrow property; if you want to close it, check `isBlacklisted(msg.sender)` (exposed by the USDC at `0x3600`) in `waive`/`acceptOffer`/`cancel`.

### L-3 "volume" mixes USDC and EURC, and `getSummary` returns an average
Lines 323-324. Both tokens are written under the same tag `"volume"` with hard-coded decimals 6, so a EUR ticket and a USD ticket are averaged together. The fork run confirmed the registry averages: tranches of 10e6 and 30e6 give a value of 20e6 with count 2. The SDK correctly names this `averageTicket`, but the currency mix is wrong.
Fix: use `tag2 = string.concat("volume-", IERC20Metadata(token).symbol())` or a per-token constant, and read the decimals from the token.

### L-4 "delivered" counts per tranche, "expired" counts per credit
Lines 322 and 336. An 8-tranche credit that fully fails yields 1 "expired" entry. One that fully succeeds yields 8 "delivered" entries. `onTimeRate` in the SDK is therefore biased upward.
Fix: write "expired" once per refunded tranche, or "delivered" once per credit (on `last`).

---

## Info

- **I-1 63/64 feedback skip: currently infeasible (measured).** The caller of `reclaim`, a relayer of `presentWithSig`, or the applicant via `waive` picks the gas limit. In theory it could make `giveFeedback` run out of gas while the tail still finishes, which would skip an entry silently. On a fork with the live registry: `reclaim` costs 191k, and the lowest gas that succeeds (196k) still writes the feedback. `present` with 2 feedbacks needs at least 360k and skips nothing. The attack becomes feasible only if the registry cost exceeds about 64 times the tail cost (roughly 350k). The `gasleft()` guard in M-1 closes it permanently.
- **I-2 `waive` after expiry (line 282).** It has no expiry check, while `present` does. Under UCP 600, a late presentation is a discrepancy the applicant may waive, so the behaviour is coherent, but document it. Note that the permissionless `reclaim` can close that window at any time after expiry.
- **I-3 feedbackHash is not unique (line 472).** `keccak256(abi.encode(id, amount, tag2))` collides for two tranches of equal amount in the same credit. Include the tranche index.
- **I-4 `presentedHash == 0` is ambiguous (line 123).** It means either "waived" or "not presented". Readers must cross-check `satisfiedDocs`.
- **I-5 EIP-7702 attestors.** Arc runs Prague. A delegated EOA has code, so `SignatureChecker` takes the ERC-1271 path. If the delegate lacks `isValidSignature`, `presentWithSig` fails for that attestor. Direct `present` still works.
- **I-6 Signed presentations are irrevocable until `deadline`.** There is no nonce, and anyone may relay them. Advise attestors to use short deadlines.
- **I-7 Trust model.** The applicant alone nominates the attestors, and the beneficiary never accepts the terms on-chain. The `attestor != applicant/beneficiary` checks (line 212) are cosmetic because a second address bypasses them. The beneficiary and any financier must verify attestor identities off-chain. Say so in the docs.
- **I-8 `_pay` edge cases (lines 445-451).** Malformed return data makes `abi.decode` revert, which is irrelevant for the allowlisted tokens. If `beneficiary == address(this)` the funds are locked forever; add `p.beneficiary != address(this)`. `owed` balances of permanently blocklisted addresses stay frozen in the contract, which is the compliance-correct behaviour.
- **I-9 Wording.** "Forfaiting" usually means a without-recourse discount of an accepted deferred-payment obligation after compliant presentation. Buying LC proceeds before shipment is an assignment of proceeds (UCP 600 art. 39), or pre-export finance. The contract implements the latter. Rename it in NatSpec and UI to avoid a trade-finance reviewer's raised eyebrow.
- **I-10 External trust.** Both ERC-8004 registries are owner-upgradeable proxies (see M-1). Document this dependency.

## Checked and found sound
- Reentrancy: the ERC-1271 check is a `staticcall` (OZ `SignatureChecker`). Token and registry calls run under `nonReentrant`. `amendExpiry` and `linkBeneficiaryAgent` make no state-changing external calls. USDC and EURC have no transfer hooks.
- Signatures: EIP-712 domain binds chainId and the contract address, the struct binds `creditId`, `tranche` and `doc`, OZ ECDSA rejects high-s, and replay is stopped by `AlreadySatisfied`. Front-running a relayed signature is harmless.
- Bitmask: `uint8(1 << doc)` for `doc >= 8` gives 0, but `doc >= MAX_DOCS` reverts first. `requiredDocs & ~allDocs` bounds the docs to `nDocs`, and `presentedHash` keys (`tranche*8+doc`) are unique.
- `int128` casts: `total <= int128.max` is enforced at open, so `int128(t.amount)` is safe.
- Accounting: `outstanding` = sum of unsettled tranches. Offers are escrowed 1:1 and `owed` is pull-based. The fuzz and invariant suites pass. `forOutstanding` stops a settlement from front-running `acceptOffer`, and since `outstanding` only decreases it cannot return to an old value.
- Timing: presentation is allowed at `ts == expiry` and `reclaim` needs `ts > expiry`, which is consistent with Arc's non-strict 1s timestamps. Nothing uses PREVRANDAO.

---

## Second pass, 2026-10-13 (before the mainnet deployment)

Two hunters worked in parallel: one on the reputation track record, one on the money held by the contract (credit escrow, offer escrow, `owed`, and now fees). The reputation findings were proven on a fork of Arc mainnet against the live ERC-8004 registries. The money hunter found no way to steal, freeze or misdirect funds: the solvency invariant held on every path traced, and it now includes collected fees.

### A-1 (Medium) An exporter could keep every failed credit out of its track record by not linking it
`linkBeneficiaryAgent(id, agentId)` was optional and per credit. An exporter linked only the credits it was about to deliver. Credits it never shipped expired with no entry, so `expired` stayed at 0 and financiers priced it as a perfect record. Proven on the fork: open, never link, reclaim, `getSummary(..., "expired")` returns 0.
**Fix:** `linkAgent(agentId)` binds an address to its identity once. Every credit where that address is the beneficiary, already open or opened later, reads the identity at settlement or refund time. (`test_audit_linkPerAddressCoversEveryCredit`)

### A-2 (Medium) An exporter could dodge a negative entry by making the contract an operator of its own identity
The ERC-8004 v2 Reputation Registry refuses feedback from the owner or an operator of the rated agent. An exporter calls `setApprovalForAll(credoc, true)` on the Identity Registry right before `reclaim`. The "expired" entry is then refused as self-feedback, the contract catches the revert so the money still moves, and the exporter revokes the approval afterwards. Proven on the fork against the live registries.
**Fix:** every refused entry increments `skippedFeedback[agentId]`. The SDK reports it, the dashboard shows it ("unrecorded"), and `quoteAssignment` gives such an exporter no trust at all. (`test_audit_refusedEntriesAreCounted`)

### A-3 (Low) An offer could be accepted when the financier's loss was already certain
`makeOffer` accepted a `validUntil` past the credit's expiry, and the web form defaulted to 3 days. At `ts == expiry`, with no document presented, the exporter could accept: the financier paid for proceeds that the next `reclaim` refunds to the importer.
**Fix:** `validUntil <= expiry` is required, and the form caps the validity at the time left. (`test_audit_offerBoundToExpiry`)

### A-4 (Low) An extension agreed after an offer made the financier wait longer than it priced
The parties could extend the expiry by up to two years, then accept an offer priced against 30 days.
**Fix:** offers record the expiry they priced, and `acceptOffer` reverts with `StaleOffer` if it changed. (`test_audit_offerBoundToExpiry`)

### Settlement fee added in the same release
- 0.25% of each settled tranche, deducted from the payee. Refunds are free.
- The rate is fixed per credit at opening; the owner (`Ownable2Step`) can only change it for future credits, never above `MAX_FEE_BPS` = 1%.
- `withdrawFees` is callable by anyone and only pays the treasury.
- Tests: `test_fee_*` and the invariant suite, which now runs with a 0.25% fee and random `withdrawFees` calls.
