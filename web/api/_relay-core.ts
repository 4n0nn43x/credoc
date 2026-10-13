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
 * presentations per 30 days. It can always submit directly and pay the gas itself.
 * ponytail: counted in memory, so a restart resets it; move to a store if abuse shows up.
 */
export const FREE_RELAYS = 5;
const WINDOW_MS = 30 * 86_400_000;
const used = new Map<string, number[]>();
export const freeQuota = {
  left(attestor: string, now = Date.now()): number {
    const recent = (used.get(attestor.toLowerCase()) ?? []).filter((t) => now - t < WINDOW_MS);
    used.set(attestor.toLowerCase(), recent);
    return Math.max(0, FREE_RELAYS - recent.length);
  },
  take(attestor: string, now = Date.now()) {
    used.set(attestor.toLowerCase(), [...(used.get(attestor.toLowerCase()) ?? []), now]);
  },
};

/**
 * Gasless presentations: an attestor signs offchain (EIP-712), this relayer submits and pays the few
 * thousandths of USDC of gas. It never trusts the request: the contract checks the signature against the
 * nominated attestor, and the call is simulated first so an invalid request costs the relayer nothing.
 */

export type RelayEnv = { rpcUrl?: string; contract?: string; relayerKey?: string };
export type RelayResult = { status: number; body: Record<string, unknown> };

const bad = (error: string, status = 400): RelayResult => ({ status, body: { error } });

export async function relayPresentation(input: unknown, env: RelayEnv): Promise<RelayResult> {
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
  const account = privateKeyToAccount(env.relayerKey as Hex);
  const pub = createPublicClient({ chain, transport: http(), pollingInterval: 500 }); // Arc: sub-second finality
  const wallet = createWalletClient({ account, chain, transport: http() });
  const args = [creditId, Number(tranche), Number(doc), docHash, deadline, signature as Hex] as const;

  try {
    // plans: with CredocPass set, relaying is free for plan holders and capped for everyone else
    const contract = env.contract as Address;
    const pass = await pub.readContract({ address: contract, abi, functionName: "pass" });
    let quotaFor: Address | null = null;
    if (pass !== "0x0000000000000000000000000000000000000000") {
      const [docs, credit] = await Promise.all([
        pub.readContract({ address: contract, abi, functionName: "getDocs", args: [creditId] }),
        pub.readContract({ address: contract, abi, functionName: "getCredit", args: [creditId] }),
      ]);
      const attestor = docs[Number(doc)]?.attestor;
      if (!attestor) return bad("BadParams", 422);
      const [a, i] = await Promise.all([
        pub.readContract({ address: pass, abi: passAbi, functionName: "isActive", args: [attestor, ATTESTOR_PLAN] }),
        pub.readContract({ address: pass, abi: passAbi, functionName: "isActive", args: [credit.applicant, IMPORTER_PLAN] }),
      ]);
      if (!a && !i) {
        if (freeQuota.left(attestor) === 0)
          return {
            status: 402,
            body: { error: "free relay quota used", plan: "attestor", freeRelays: FREE_RELAYS, hint: "Buy an attestor plan, or submit the presentation yourself." },
          };
        quotaFor = attestor;
      }
    }
    const { request } = await pub.simulateContract({
      address: env.contract as Address,
      abi,
      functionName: "presentWithSig",
      args,
      account,
    });
    const t0 = Date.now();
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") return bad("transaction reverted", 502);
    if (quotaFor) freeQuota.take(quotaFor);
    return { status: 200, body: { hash, seconds: (Date.now() - t0) / 1000, block: receipt.blockNumber.toString() } };
  } catch (e) {
    const revert =
      e instanceof BaseError
        ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null)
        : null;
    if (revert?.data?.errorName) return bad(revert.data.errorName, 422);
    return bad(e instanceof BaseError ? e.shortMessage : "relay failed", 502);
  }
}

export const envFromProcess = (): RelayEnv => ({
  rpcUrl: process.env.VITE_RPC_URL,
  contract: process.env.VITE_CREDOC_ADDRESS,
  relayerKey: process.env.RELAYER_KEY,
});
