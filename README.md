# Credoc: letters of credit for small importers, settled on Arc

A letter of credit is how big companies trade with strangers across borders: the importer's bank promises to pay the exporter as soon as shipping documents prove the goods left. Small importers rarely get one. The Asian Development Bank puts the global trade finance gap at 2.5 trillion USD, and 41% of SME applications are rejected.

Credoc is a cash-backed letter of credit as a smart contract on Arc. The importer locks USDC or EURC, the freight forwarder signs the bill of lading, and the exporter is paid in the same second. No bank, no correspondent chain, no minimum ticket.

## How it works

1. **Open.** The importer locks the full amount, split into tranches (one per container or partial shipment). Each tranche lists the documents it needs and who is allowed to attest each one: a freight forwarder for the bill of lading, an inspection agency for the inspection certificate, and so on.
2. **Present.** Each attestor presents the hash of its document. The file itself never goes onchain. Attestors can sign offchain (EIP-712, also ERC-1271 smart wallets), and anyone relays the signature, so a forwarder needs no wallet funding at all.
3. **Settle.** When the last required document of a tranche lands, the tranche is paid to the payee in that same transaction. Arc's deterministic finality makes it final at once.
4. **Waive.** If a document is late or has a discrepancy, the importer can accept it anyway (UCP 600 article 16).
5. **Expire.** After expiry, anyone can close the credit and unshipped tranches go back to the importer.
6. **Amend.** Extending the expiry needs both sides (UCP 600 article 10). Expiry can only move later, and never after it has passed. Only the payee can cancel early: the credit is irrevocable.

### Assignment of proceeds: the exporter gets paid before shipping

Any financier can offer to buy the remaining proceeds of a credit at a discount (UCP 600 article 39), with the price escrowed in the contract. The exporter accepts and is paid immediately. When the documents arrive, the financier collects face value. The receivable can be resold. Offers are bound to the outstanding amount they priced, so a partially settled credit cannot be sold at a stale price.

### A portable track record (ERC-8004)

Importers name an [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) identity when they open a credit. Exporters link one to their address, once (`linkAgent`): every credit where they are the beneficiary, open or future, then counts, so nobody can pick which credits enter their record. The contract writes to the canonical ERC-8004 Reputation Registry on Arc:

| Event | Entry (`tag1 = credoc`) |
|---|---|
| Tranche settled, every document presented by its attestor | `delivered = 100` |
| Tranche settled only thanks to importer waivers | `waived = 100`, kept apart from deliveries |
| Tranche refunded at expiry | `expired = 0` |
| Tranche renounced by the payee | `cancelled = 0` |
| Any settlement, both parties | `volume-USDC` or `volume-EURC` = amount |

The registry is open to anyone, so it can be spammed. But `getSummary` takes the list of trusted clients. Reading it with `[this contract]` only counts entries written during settlements through this contract. Financiers then price the next receivable from that history (see `quoteAssignment` in the SDK).

Registry calls get a fixed gas budget and cannot revert a payment. A caller cannot starve them on purpose either: the transaction reverts instead of silently skipping an entry. An entry the registry refuses (for example because the exporter made this contract an operator of its own identity, which the registry treats as self-feedback) is counted in `skippedFeedback`, and the SDK prices such an exporter as having no history.

## Business model

Credoc takes **0.25% of each settled tranche**, deducted from the payee's proceeds (the exporter, or the financier who bought the receivable). Refunds at expiry or cancellation are free: the importer pays nothing if the goods never ship. A bank letter of credit typically costs 0.75% to 1.5% plus fixed minimums.

- The rate is fixed when a credit opens. The owner can change it for future credits only, and never above the 1% hard cap (`MAX_FEE_BPS`).
- Fees accrue in the contract per token and go to the treasury address through `withdrawFees`, which anyone can call.
- Next: subscriptions for attestors (multi-client dashboard, API, batch signing), importers (templates, teams, accounting export) and financiers (receivables feed, pricing API), then white-label licences for fintechs and banks.

## Why Arc

| Arc primitive | How Credoc uses it |
|---|---|
| USDC and EURC issued natively by Circle | Settlement in dollars or euros. EURC fits Europe and the CFA franc zone, pegged to the euro. |
| USDC as gas | Every fee is in dollars, so the importer holds no volatile token. |
| Deterministic sub-second finality | The exporter's payment is final the moment the document is attested. |
| `Memo` (0x5294...e505) | The opening is wrapped in a Memo carrying the purchase-order reference, indexed by Arc tooling, while the importer stays `msg.sender`. |
| `Multicall3From` (0x522f...47D0) | Approve and Memo-tagged open in **one** transaction, sender preserved. |
| ERC-8004 registries (canonical addresses, v2.0.0) | Portable credit history for both parties. |

## Repository

```
contracts/   Foundry project: DocumentaryCredit.sol, tests, deploy script
sdk/         TypeScript SDK (viem), end-to-end demo, attestor CLI
web/         Landing page and dashboard (Vite, React), gasless relayer (serverless function)
```

## Run the tests

```bash
cd contracts && npm install
forge test                      # unit (38, incl. fuzz) + invariant (2) tests; fork tests skip outside Arc
```

Fork tests run against real Arc mainnet state (native USDC, EURC, ERC-8004, Memo, Multicall3From). They need [Arc Foundry](https://docs.arc.io/arc/tutorials/install-arc-foundry), because stock Foundry cannot execute Arc's USDC precompile:

```bash
arc-forge test --match-contract ForkTest --fork-url https://rpc.mainnet.arc.io
```

## End-to-end demo

```bash
arc-anvil --fork-url https://rpc.mainnet.arc.io --chain-id 5042   # local fork of Arc mainnet
cd sdk && npm install && npm test && npm run e2e
```

The demo deploys the contract, registers ERC-8004 identities, opens a two-container credit in one transaction, prices the receivable from the exporter's history and sells it to a financier, has a zero-balance forwarder and inspector sign offchain while a relayer submits, settles both tranches, lets a second credit expire, and prints the exporter's resulting track record.

## Web app

The landing page (`web/index.html`, Tailwind) and the dashboard (`web/app/`, built on the Osen Bootstrap theme recompiled with Credoc's tokens) share the same ink, warm grays, serif display face and logo.

The dashboard indexes the contract's events in the browser, so it needs no backend. It covers the four roles:
- **Importers** open a credit with a 4-step wizard (one transaction), review documents, waive discrepancies, extend or reclaim.
- **Exporters** link their identity, review and accept financing offers.
- **Attestors** drop a file, see its fingerprint, sign for free; a relayer (`web/api/relay.ts`) submits.
- **Financiers** browse receivables with the exporter's track record and make escrowed offers.

Public pages need no wallet: `/app/#/track/<id>` follows a credit like a parcel, `/app/#/verify` checks a file against every presented document.

The app runs on Arc mainnet. Copy `web/.env.example` to `web/.env.local`, set the deployed contract address and block, then:

```bash
cd web && npm install
npm run dev     # http://localhost:5173 and /app/
```

`npm test` runs the relayer and view-logic tests. `npm run osen` recompiles the theme from a licensed copy of the Osen template (`OSEN_DIR`); only the compiled CSS is in this repo.

## Hosting and CI/CD

credoc.xyz runs on a single server behind a shared Caddy (TLS, security headers, CSP). The image (`Dockerfile`) is a
distroless Node runtime serving the built site and the relayer, run read-only, non-root and without capabilities
(`deploy/compose.yaml`). The relayer key lives only in the server's `.env`.

Every pull request to `main` runs the gates in `.github/workflows/ci.yml`:

| Gate | Tool | Blocks |
|---|---|---|
| Workflow audit | zizmor | yes |
| Secrets, full history | gitleaks | yes |
| Dependencies | Trivy, fixable high/critical | yes |
| Contracts | forge test (unit, fuzz, invariants) | yes |
| SDK and web | typecheck, tests, build | yes |
| Image | hadolint, Trivy, fixable high/critical | yes |
| Source | Semgrep | report only for now |

A merge to `main` reruns them and ships the exact image that was scanned: the deploy job streams it over SSH with a key
that can only run `deploy/deploy.sh`, which loads it, waits for the healthcheck and rolls back on failure. Actions are
pinned by commit SHA and Dependabot proposes updates weekly. Disclosure policy: `SECURITY.md`.

## Attestor CLI

```bash
ATTESTOR_KEY=0x... npm run attest -- --contract 0x... --credit 1 --tranche 0 --doc 0 --file ./bill-of-lading.pdf
```

It prints a signed presentation that anyone can relay. Add `--relay` with `RELAYER_KEY` to submit it.

## Deploy

```bash
cd contracts
TREASURY=0x... arc-forge script script/Deploy.s.sol --rpc-url arc --account <keystore> --broadcast
```

The deployer becomes the owner of the fee settings. `FEE_BPS` defaults to 25 (0.25%).

The deployment uses about 4.3M gas, roughly 0.09 to 0.17 USDC.

## Known limits

- The identity registry is permissionless: an attestor's ERC-8004 identity does not prove it is a real forwarder. The importer chooses attestors it trusts when opening the credit.
- Wash trading between two wallets of the same person, with a third wallet as attestor, can still inflate a track record. Readers should weigh it by volume and by attestor diversity. Settlements obtained through waivers are tagged apart.
- The ERC-8004 registries are upgradeable by their owner. Credoc never lets them block a payment, but the meaning of past entries depends on them.
- Wallets with an EIP-7702 delegation whose code does not implement `onERC721Received` cannot register an ERC-8004 identity (`_safeMint` reverts).
- Amounts are public. Arc's opt-in privacy, on the roadmap, would hide commercial terms from competitors.

## Security review

An independent review found one high, two medium and four low issues ([report](docs/security-review.md), written against the first version). All are fixed and each has a regression test (`test_review_*`). The exploit proofs of concept from the review fail against the current contract. A second pass before the mainnet deployment found two more ways to keep failures out of a track record and two ways to turn an offer against its financier; all four are fixed (`test_audit_*`, same report).

## License

Copyright (c) 2026 4n0nn43x. All rights reserved. The source is shown for the Arc Microgrants review; no license to use, copy or redistribute it is granted.
