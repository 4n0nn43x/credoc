import {
  type Address,
  type Hex,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isHex,
  nonceManager,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "viem/chains";

// Self-contained on purpose: serverless bundlers should not have to compile the SDK's TypeScript sources.
// The custom errors are listed so a revert decodes to its name (e.g. "Expired") for the client.
const abi = parseAbi([
  "function presentWithSig(uint256 id, uint8 tranche, uint8 doc, bytes32 docHash, uint256 deadline, bytes signature)",
  "error TokenNotAllowed()",
  "error BadParams()",
  "error NotActive()",
  "error Unauthorized()",
  "error Expired()",
  "error NotExpired()",
  "error AlreadySatisfied()",
  "error NotRequired()",
  "error BadSignature()",
  "error SignatureExpired()",
  "error OfferUnavailable()",
  "error StaleOffer()",
  "error NothingOwed()",
  "error AlreadyLinked()",
  "error InsufficientGas()",
  "function pass() view returns (address)",
  "function getDocs(uint256 id) view returns ((bytes32 docType, address attestor)[])",
  "function getCredit(uint256 id) view returns ((address applicant, address beneficiary, address payee, address token, uint64 expiry, uint8 status, uint16 feeBps, uint128 total, uint128 outstanding, uint256 applicantAgent, uint256 beneficiaryAgent, bytes32 terms, address partner, uint16 partnerShareBps, uint16 integratorFeeBps))",
]);
const passAbi = parseAbi(["function isActive(address account, uint8 plan) view returns (bool)"]);
const ATTESTOR_PLAN = 1;
const IMPORTER_PLAN = 2;

/**
 * Free tier: an attestor without a plan, on a credit whose importer has none either, gets FREE_RELAYS relayed
 * presentations per 30 days, and each importer (the applicant, who locked the funds) FREE_RELAYS_PER_APPLICANT across
 * its credits, so fresh attestor addresses do not refill it. It can always submit directly and pay the gas itself.
 * Only wallet (EOA) attestors get it: a contract attestor runs its own code inside the relayed transaction (ERC-1271),
 * so it can pass the simulation and still revert onchain, burning the relayer's gas. With a plan it is relayed.
 */
export const FREE_RELAYS = 5;
export const FREE_RELAYS_PER_APPLICANT = 10;
const WINDOW_MS = 30 * 86_400_000;
/**
 * Gas the relayer pays at most per presentation. The worst case measured in contracts/test is about 0.98M (the last
 * presentation settles the credit: plan lookup, token transfer and three ERC-8004 calls of FEEDBACK_GAS = 250k each,
 * against a registry burning all of it); 1.5M leaves room for an ERC-1271 check and the intrinsic cost.
 */
export const RELAY_GAS_LIMIT = 1_500_000n;

/** Where relayed presentations are counted: SQLite in production (server/analytics.ts), memory otherwise. */
export type RelayLedger = { count(key: string, since: number): number; add(key: string, now: number): void };

export function memoryLedger(): RelayLedger {
  const used = new Map<string, number[]>();
  return {
    count(key, since) {
      const recent = (used.get(key) ?? []).filter((t) => t > since);
      if (recent.length) used.set(key, recent);
      else used.delete(key);
      return recent.length;
    },
    add(key, now) {
      used.set(key, [...(used.get(key) ?? []), now]);
    },
  };
}

/** Takes one unit from every limit, or none. Synchronous, so no other request of this process can interleave. */
export function reserve(ledger: RelayLedger, limits: [key: string, max: number][], now = Date.now()): boolean {
  if (limits.some(([key, max]) => ledger.count(key, now - WINDOW_MS) >= max)) return false;
  for (const [key] of limits) ledger.add(key, now);
  return true;
}

const memory = memoryLedger();
const attestorKey = (a: string) => `attestor:${a.toLowerCase()}`;
export const freeQuota = {
  left: (attestor: string, now = Date.now()) => Math.max(0, FREE_RELAYS - memory.count(attestorKey(attestor), now - WINDOW_MS)),
  take: (attestor: string, now = Date.now()) => memory.add(attestorKey(attestor), now),
};

/** (credit, tranche, doc) being relayed right now: a second identical request would only pay for a revert. */
const inflight = new Set<string>();

/**
 * Gasless presentations: an attestor signs offchain (EIP-712), this relayer submits and pays the few
 * thousandths of USDC of gas. It never trusts the request: the contract checks the signature against the
 * nominated attestor, and the call is simulated first so an invalid request costs the relayer nothing.
 */

/** receiptTimeoutMs: how long to wait for the receipt before answering 202 with the hash (tests shorten it). */
export type RelayEnv = { rpcUrl?: string; contract?: string; relayerKey?: string; receiptTimeoutMs?: number };
export type RelayResult = { status: number; body: Record<string, unknown> };

const bad = (error: string, status = 400): RelayResult => ({ status, body: { error } });
const quotaUsed: RelayResult = {
  status: 402,
  body: { error: "free relay quota used", plan: "attestor", freeRelays: FREE_RELAYS, hint: "Buy an attestor plan, or submit the presentation yourself." },
};

export async function relayPresentation(input: unknown, env: RelayEnv, ledger: RelayLedger = memory): Promise<RelayResult> {
  if (!env.relayerKey || !/^0x[0-9a-fA-F]{64}$/.test(env.relayerKey)) return bad("relayer is not configured", 503);
  if (!env.contract || !isAddress(env.contract)) return bad("contract is not configured", 503);

  const p = (input ?? {}) as Record<string, unknown>;
  const int = (v: unknown, max: bigint) => {
    try {
      const n = BigInt(String(v));
      return n >= 0n && n <= max ? n : null;
    } catch {
      return null;
    }
  };
  const creditId = int(p.creditId, 2n ** 64n);
  const tranche = int(p.tranche, 7n);
  const doc = int(p.doc, 7n);
  const deadline = int(p.deadline, 2n ** 64n);
  const docHash = p.docHash;
  const signature = p.signature;
  if (creditId === null || tranche === null || doc === null || deadline === null) return bad("invalid numbers");
  if (!isHex(docHash) || docHash.length !== 66) return bad("docHash must be 32 bytes");
  if (!isHex(signature) || signature.length < 132 || signature.length > 2 + 2 * 2048) return bad("invalid signature");

  const chain = { ...arc, rpcUrls: { default: { http: [env.rpcUrl || arc.rpcUrls.default.http[0]] } } };
  // one nonce sequence per relayer address for the whole process: concurrent relays must not reuse a nonce
  const account = privateKeyToAccount(env.relayerKey as Hex, { nonceManager });
  const pub = createPublicClient({ chain, transport: http(), pollingInterval: 500 }); // Arc: sub-second finality
  const wallet = createWalletClient({ account, chain, transport: http() });
  const args = [creditId, Number(tranche), Number(doc), docHash, deadline, signature as Hex] as const;

  const lock = `${creditId}:${tranche}:${doc}`;
  if (inflight.has(lock)) return bad("this document is already being relayed", 409);
  inflight.add(lock);
  try {
    // plans: relaying is free for plan holders (CredocPass) and capped for everyone else, CredocPass set or not
    const contract = env.contract as Address;
    const [pass, docs, credit] = await Promise.all([
      pub.readContract({ address: contract, abi, functionName: "pass" }),
      pub.readContract({ address: contract, abi, functionName: "getDocs", args: [creditId] }),
      pub.readContract({ address: contract, abi, functionName: "getCredit", args: [creditId] }),
    ]);
    const attestor = docs[Number(doc)]?.attestor;
    if (!attestor) return bad("BadParams", 422);
    let plan = false;
    if (pass !== "0x0000000000000000000000000000000000000000") {
      const [a, i] = await Promise.all([
        pub.readContract({ address: pass, abi: passAbi, functionName: "isActive", args: [attestor, ATTESTOR_PLAN] }),
        pub.readContract({ address: pass, abi: passAbi, functionName: "isActive", args: [credit.applicant, IMPORTER_PLAN] }),
      ]);
      plan = a || i;
    }
    const limits: [string, number][] = plan
      ? []
      : [
          [attestorKey(attestor), FREE_RELAYS],
          [`applicant:${credit.applicant.toLowerCase()}`, FREE_RELAYS_PER_APPLICANT],
        ];
    if (!plan) {
      const code = await pub.getCode({ address: attestor }); // also catches EIP-7702 delegated accounts
      if (code && code !== "0x")
        return {
          status: 402,
          body: { error: "free relay is for wallet attestors", plan: "attestor", hint: "A contract attestor needs a plan, or submits the presentation itself." },
        };
      if (limits.some(([key, max]) => ledger.count(key, Date.now() - WINDOW_MS) >= max)) return quotaUsed;
    }
    // simulated with the gas cap it is sent with: a presentation that needs more is refused here, for free
    const { request } = await pub.simulateContract({
      address: contract,
      abi,
      functionName: "presentWithSig",
      args,
      account,
      gas: RELAY_GAS_LIMIT,
    });
    // counted before sending and never refunded: a reverted transaction costs the relayer as much as a good one
    if (!reserve(ledger, limits)) return quotaUsed;
    const t0 = Date.now();
    const hash = await wallet.writeContract({ ...request, gas: RELAY_GAS_LIMIT });
    let receipt;
    try {
      receipt = await pub.waitForTransactionReceipt({ hash, timeout: env.receiptTimeoutMs ?? 30_000 });
    } catch {
      // sent, but no receipt yet (timeout or RPC hiccup): not a failure, the client follows the hash
      return { status: 202, body: { hash, status: "pending" } };
    }
    if (receipt.status !== "success") return bad("transaction reverted", 502);
    return { status: 200, body: { hash, seconds: (Date.now() - t0) / 1000, block: receipt.blockNumber.toString() } };
  } catch (e) {
    const revert =
      e instanceof BaseError
        ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null)
        : null;
    if (revert?.data?.errorName) return bad(revert.data.errorName, 422);
    return bad(e instanceof BaseError ? e.shortMessage : "relay failed", 502);
  } finally {
    inflight.delete(lock);
  }
}

export const envFromProcess = (): RelayEnv => ({
  rpcUrl: process.env.VITE_RPC_URL,
  contract: process.env.VITE_CREDOC_ADDRESS,
  relayerKey: process.env.RELAYER_KEY,
});
