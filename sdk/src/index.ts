import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToHex,
  zeroAddress,
} from "viem";
import { documentaryCreditAbi } from "./abi.ts";

export { documentaryCreditAbi, documentaryCreditBytecode } from "./abi.ts";

// ---------------------------------------------------------------- Arc constants

/** Arc mainnet system and Circle contracts (docs.arc.io/arc/references/contract-addresses). */
export const ARC = {
  chainId: 5042,
  usdc: "0x3600000000000000000000000000000000000000",
  eurc: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
  multicall3From: "0x522fAf9A91c41c443c66765030741e4AaCe147D0",
} as const satisfies Record<string, Address | number>;

/** USDC and EURC both use 6 decimals on their ERC-20 interface. */
export const TOKEN_DECIMALS = 6;

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const memoAbi = parseAbi([
  "function memo(address target, bytes data, bytes32 memoId, bytes memoData)",
]);
const multicall3FromAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) returns (Result[])",
]);
const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);
/** CredocPass: prepaid plans (attestor 1, importer 2, financier 3), 30-day periods, paid in USDC. */
export const passAbi = parseAbi([
  "function price(uint8 plan) view returns (uint96)",
  "function quote(uint8 plan, uint16 periods) view returns (uint256)",
  "function activeUntil(address account, uint8 plan) view returns (uint64)",
  "function isActive(address account, uint8 plan) view returns (bool)",
  "function verified(address account) view returns (bool)",
  "function usdc() view returns (address)",
  "function buy(address account, uint8 plan, uint16 periods) returns (uint64 until)",
  "event PassBought(address indexed account, uint8 indexed plan, uint64 until, address payer, uint256 paid)",
  "event PassGranted(address indexed account, uint8 indexed plan, uint64 until)",
  "error BadParams()",
  "error NotForSale()",
]);
export const PLAN = { attestor: 1, importer: 2, financier: 3 } as const;
export type PlanName = keyof typeof PLAN;
export type PlanStatus = Record<PlanName, { until: bigint; active: boolean; price: bigint }> & { verified: boolean };

const reputationAbi = parseAbi([
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

// ---------------------------------------------------------------- documents

/** Standard document labels (UCP 600 vocabulary). Any label works: the contract stores keccak256(label). */
export const DOC_LABELS = [
  "BILL_OF_LADING",
  "AIR_WAYBILL",
  "COMMERCIAL_INVOICE",
  "PACKING_LIST",
  "CERTIFICATE_OF_ORIGIN",
  "INSPECTION_CERTIFICATE",
  "INSURANCE_CERTIFICATE",
  "PHYTOSANITARY_CERTIFICATE",
] as const;

export const docType = (label: string): Hex => keccak256(stringToHex(label));

/** Reverse lookup of a docType hash to its label, for the standard labels. */
export const docLabel = (hash: Hex): string =>
  DOC_LABELS.find((l) => docType(l) === hash.toLowerCase()) ?? hash;

/** Fingerprint of a document file. Only this hash goes onchain; the file itself never leaves the parties. */
export const hashDocument = (bytes: Uint8Array): Hex => keccak256(bytes);

/** Bitmask helper: docs(0, 2) => requiredDocs covering documents 0 and 2. */
export const docs = (...indexes: number[]): number => {
  let m = 0;
  for (const i of indexes) {
    if (!Number.isInteger(i) || i < 0 || i > 7) throw new Error(`doc index out of range: ${i}`);
    m |= 1 << i;
  }
  return m;
};

// ---------------------------------------------------------------- EIP-712 presentation

export const presentationTypes = {
  Presentation: [
    { name: "creditId", type: "uint256" },
    { name: "tranche", type: "uint8" },
    { name: "doc", type: "uint8" },
    { name: "docHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const presentationDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "DocumentaryCredit", version: "1", chainId, verifyingContract }) as const;

export type Presentation = {
  creditId: bigint;
  tranche: number;
  doc: number;
  docHash: Hex;
  deadline: bigint;
};

export type SignedPresentation = Presentation & { attestor: Address; signature: Hex };

/**
 * The attestor (freight forwarder, inspector...) signs offchain: no wallet funding, no gas.
 * Anyone can then relay the signature with `presentWithSig`.
 */
export async function signPresentation(
  wallet: WalletClient<Transport, Chain | undefined, Account>,
  contract: Address,
  chainId: number,
  p: Presentation,
): Promise<SignedPresentation> {
  const signature = await wallet.signTypedData({
    account: wallet.account,
    domain: presentationDomain(chainId, contract),
    types: presentationTypes,
    primaryType: "Presentation",
    message: { ...p },
  });
  return { ...p, attestor: wallet.account.address, signature };
}

// ---------------------------------------------------------------- credit types

export type DocRequirement = { docType: Hex; attestor: Address };
export type TrancheSpec = { amount: bigint; requiredDocs: number };

export type OpenParams = {
  beneficiary: Address;
  token: Address;
  expiry: bigint;
  terms: Hex;
  applicantAgent?: bigint; // ERC-8004 agentId, omitted = none
  docs: DocRequirement[];
  tranches: TrancheSpec[];
  partner?: Address; // white-label partner or integrator the credit is opened through
  integratorFeeBps?: number; // its own fee on settled tranches, at most 50 (0.5%)
};

export enum Status {
  None = 0,
  Active = 1,
  Closed = 2,
}

export type CreditView = {
  id: bigint;
  applicant: Address;
  beneficiary: Address;
  payee: Address;
  token: Address;
  expiry: bigint;
  status: Status;
  feeBps: number; // Credoc's settlement fee for this credit, fixed when it opened
  total: bigint;
  outstanding: bigint;
  applicantAgent: bigint | null;
  beneficiaryAgent: bigint | null;
  terms: Hex;
  partner: Address | null;
  partnerShareBps: number; // the partner's share of Credoc's fee
  integratorFeeBps: number; // the partner's own fee on top
  docs: (DocRequirement & { label: string })[];
  tranches: {
    amount: bigint;
    requiredDocs: number;
    satisfiedDocs: number;
    waivedDocs: number;
    settled: boolean;
    documents: { doc: number; required: boolean; satisfied: boolean; hash: Hex | null; waived: boolean }[];
  }[];
};

export type Reputation = {
  delivered: number; // tranches settled with every document presented by its attestor
  waived: number; // tranches settled only thanks to applicant waivers (not counted as deliveries)
  expired: number; // tranches refunded at expiry
  cancelled: number; // tranches renounced by the beneficiary while still payee
  assigneeCancelled: number; // tranches renounced by whoever bought the proceeds, not by the beneficiary
  skipped: number; // entries the registry refused (e.g. the agent made this contract its operator): treat as a red flag
  onTimeRate: number | null; // delivered / (delivered + expired + cancelled + assigneeCancelled), null without history
  averageTicket: bigint | null; // average settled tranche in the chosen token, token units
};

const toContractParams = (p: OpenParams) => ({
  beneficiary: p.beneficiary,
  token: p.token,
  expiry: p.expiry,
  terms: p.terms,
  applicantAgent: p.applicantAgent === undefined ? 0n : p.applicantAgent + 1n,
  docs: p.docs,
  tranches: p.tranches.map((t) => ({ amount: t.amount, requiredDocs: t.requiredDocs })),
  partner: p.partner ?? zeroAddress,
  integratorFeeBps: p.integratorFeeBps ?? 0,
});

/** Client-side mirror of the contract's `open` checks, so the UI can explain errors before sending. */
export function validateOpenParams(p: OpenParams, applicant: Address, now: bigint): string[] {
  const errors: string[] = [];
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (eq(p.beneficiary, applicant)) errors.push("beneficiary must differ from applicant");
  if (p.expiry <= now) errors.push("expiry must be in the future");
  if (p.expiry > now + 730n * 86400n) errors.push("expiry must be within 730 days");
  if (p.docs.length === 0 || p.docs.length > 8) errors.push("between 1 and 8 documents");
  if (p.tranches.length === 0 || p.tranches.length > 8) errors.push("between 1 and 8 tranches");
  const all = (1 << p.docs.length) - 1;
  p.docs.forEach((d, i) => {
    if (/^0x0{40}$/i.test(d.attestor)) errors.push(`document ${i}: attestor missing`);
    if (eq(d.attestor, applicant) || eq(d.attestor, p.beneficiary))
      errors.push(`document ${i}: attestor must be independent from both parties`);
  });
  p.tranches.forEach((t, i) => {
    if (t.amount <= 0n) errors.push(`tranche ${i}: amount must be positive`);
    if (t.requiredDocs === 0 || (t.requiredDocs & ~all) !== 0) errors.push(`tranche ${i}: invalid required documents`);
  });
  return errors;
}

// ---------------------------------------------------------------- assignment of proceeds pricing

/**
 * Suggested price for buying the remaining proceeds of a credit today (assignment of proceeds, UCP 600 art. 39).
 * price = outstanding / (1 + rate * days / 365), rate = base + risk premium scaled by the exporter's track record.
 * Pure helper for the financier UI; the contract accepts any price.
 */
export function quoteAssignment(args: {
  outstanding: bigint;
  daysToExpiry: number;
  baseRate?: number; // annual, e.g. 0.08
  maxRiskPremium?: number; // annual premium for an exporter with no history
  reputation?: Reputation;
}): { price: bigint; annualRate: number; discount: bigint } {
  const base = args.baseRate ?? 0.08;
  const maxPremium = args.maxRiskPremium ?? 0.2;
  const r = args.reputation;
  // trust grows with on-time rate and with history depth (saturates around 20 deliveries)
  const history = r ? r.delivered + r.expired + r.cancelled : 0;
  // an exporter whose entries were refused may be hiding expiries: no trust at all
  const trust = r && r.onTimeRate !== null && r.skipped === 0 ? r.onTimeRate * Math.min(1, history / 20) : 0;
  const annualRate = base + maxPremium * (1 - trust);
  const days = Math.max(0, args.daysToExpiry);
  // fixed-point at 1e9 to stay in bigint arithmetic
  const denom = BigInt(Math.round((1 + (annualRate * days) / 365) * 1e9));
  const price = (args.outstanding * 1_000_000_000n) / denom;
  return { price, annualRate, discount: args.outstanding - price };
}

/**
 * What the payee receives for the unsettled tranches, as the contract's `_settleFees` computes it, tranche by
 * tranche: amount - Credoc's fee - the integrator fee, each rounded down. `proFeeBps` applies only if it is
 * lower than the credit's rate; pass it when the payee holds an active financier plan.
 */
export function netProceeds(
  c: Pick<CreditView, "feeBps" | "integratorFeeBps"> & { tranches: readonly { amount: bigint; settled: boolean }[] },
  proFeeBps?: number,
): bigint {
  const rate = BigInt(proFeeBps !== undefined && proFeeBps < c.feeBps ? proFeeBps : c.feeBps);
  const integ = BigInt(c.integratorFeeBps);
  return c.tranches
    .filter((t) => !t.settled)
    .reduce((sum, t) => sum + t.amount - (t.amount * rate) / 10_000n - (t.amount * integ) / 10_000n, 0n);
}

// ---------------------------------------------------------------- client

type Wallet = WalletClient<Transport, Chain | undefined, Account>;

/** Optional lifecycle callbacks, so a UI can show "sent" before the receipt and measure finality. */
export type TxHooks = {
  onSubmitted?: (hash: Hex) => void;
  onConfirmed?: (hash: Hex) => void;
};

export class Credoc {
  constructor(
    readonly publicClient: PublicClient,
    readonly address: Address,
    readonly wallet?: Wallet,
    readonly hooks: TxHooks = {},
  ) {}

  /** Every transaction this client sends goes through here. */
  private async receipt(hash: Hex) {
    this.hooks.onSubmitted?.(hash);
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    this.hooks.onConfirmed?.(hash);
    return r;
  }

  private get w(): Wallet {
    if (!this.wallet) throw new Error("a wallet client is required for this action");
    return this.wallet;
  }

  private async send(functionName: string, args: readonly unknown[]): Promise<Hex> {
    const { request } = await this.publicClient.simulateContract({
      address: this.address,
      abi: documentaryCreditAbi,
      functionName: functionName as never,
      args: args as never,
      account: this.w.account,
    });
    const hash = await this.w.writeContract(request as never);
    const receipt = await this.receipt(hash);
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }

  // ---- issuance

  /**
   * Opens a credit. With `oneClick` (default), approval and opening go in a single Arc transaction through
   * Multicall3From, and the opening is wrapped in Arc's Memo so the purchase-order reference is indexed by
   * Arc tooling. Both preserve the importer as msg.sender; they need an EOA wallet.
   */
  async open(p: OpenParams, ref: string, opts: { oneClick?: boolean } = {}): Promise<{ id: bigint; hash: Hex }> {
    const total = p.tranches.reduce((s, t) => s + t.amount, 0n);
    const openData = encodeFunctionData({
      abi: documentaryCreditAbi,
      functionName: "open",
      args: [toContractParams(p), ref],
    });
    let hash: Hex;
    if (opts.oneClick ?? true) {
      const memoId = keccak256(stringToHex(ref));
      hash = await this.w.writeContract({
        address: ARC.multicall3From,
        abi: multicall3FromAbi,
        functionName: "aggregate3",
        args: [
          [
            {
              target: p.token,
              allowFailure: false,
              callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.address, total] }),
            },
            {
              target: ARC.memo,
              allowFailure: false,
              callData: encodeFunctionData({
                abi: memoAbi,
                functionName: "memo",
                args: [this.address, openData, memoId, stringToHex(ref)],
              }),
            },
          ],
        ],
        chain: this.w.chain,
        account: this.w.account,
      });
    } else {
      const allowance = await this.publicClient.readContract({
        address: p.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [this.w.account.address, this.address],
      });
      if (allowance < total) {
        const h = await this.w.writeContract({
          address: p.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [this.address, total],
          chain: this.w.chain,
          account: this.w.account,
        });
        if ((await this.receipt(h)).status !== "success") throw new Error(`approve reverted: ${h}`);
      }
      hash = await this.w.sendTransaction({
        to: this.address,
        data: openData,
        chain: this.w.chain,
        account: this.w.account,
      });
    }
    const receipt = await this.receipt(hash);
    if (receipt.status !== "success") throw new Error(`open reverted: ${hash}`);
    const [ev] = parseEventLogs({ abi: documentaryCreditAbi, eventName: "CreditOpened", logs: receipt.logs });
    if (!ev) throw new Error("CreditOpened event not found");
    return { id: ev.args.creditId, hash };
  }

  /** Bind the connected wallet to its ERC-8004 identity, once: every credit where it is the exporter then counts. */
  linkAgent = (agentId: bigint) => this.send("linkAgent", [agentId]);

  // ---- presentation

  present = (id: bigint, tranche: number, doc: number, docHash: Hex) =>
    this.send("present", [id, tranche, doc, docHash]);

  /** Relay an attestor's offchain signature (the relayer pays the gas). */
  relay = (s: SignedPresentation) =>
    this.send("presentWithSig", [s.creditId, s.tranche, s.doc, s.docHash, s.deadline, s.signature]);

  waive = (id: bigint, tranche: number, doc: number) => this.send("waive", [id, tranche, doc]);

  // ---- lifecycle

  reclaim = (id: bigint) => this.send("reclaim", [id]);
  cancel = (id: bigint) => this.send("cancel", [id]);
  amendExpiry = (id: bigint, newExpiry: bigint) => this.send("amendExpiry", [id, newExpiry]);
  withdrawExpiryProposal = (id: bigint) => this.send("withdrawExpiryProposal", [id]);
  withdrawOwed = (token: Address) => this.send("withdrawOwed", [token]);

  // ---- assignment of proceeds

  async makeOffer(id: bigint, price: bigint, validUntil: bigint): Promise<{ offerId: bigint; hash: Hex }> {
    const c = await this.getCredit(id);
    const allowance = await this.publicClient.readContract({
      address: c.token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.w.account.address, this.address],
    });
    if (allowance < price) {
      const h = await this.w.writeContract({
        address: c.token,
        abi: erc20Abi,
        functionName: "approve",
        args: [this.address, price],
        chain: this.w.chain,
        account: this.w.account,
      });
      if ((await this.receipt(h)).status !== "success") throw new Error(`approve reverted: ${h}`);
    }
    const hash = await this.send("makeOffer", [id, price, validUntil]);
    const receipt = await this.publicClient.getTransactionReceipt({ hash });
    const [ev] = parseEventLogs({ abi: documentaryCreditAbi, eventName: "OfferMade", logs: receipt.logs });
    if (!ev) throw new Error("OfferMade event not found");
    return { offerId: ev.args.offerId, hash };
  }

  acceptOffer = (offerId: bigint) => this.send("acceptOffer", [offerId]);
  withdrawOffer = (offerId: bigint) => this.send("withdrawOffer", [offerId]);

  // ---- reads

  private read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return this.publicClient.readContract({
      address: this.address,
      abi: documentaryCreditAbi,
      functionName: functionName as never,
      args: args as never,
    }) as Promise<T>;
  }

  async getCredit(id: bigint): Promise<CreditView> {
    type RawCredit = {
      applicant: Address;
      beneficiary: Address;
      payee: Address;
      token: Address;
      expiry: bigint;
      status: number;
      feeBps: number;
      total: bigint;
      outstanding: bigint;
      applicantAgent: bigint;
      beneficiaryAgent: bigint;
      terms: Hex;
      partner: Address;
      partnerShareBps: number;
      integratorFeeBps: number;
    };
    const [c, d, t] = await Promise.all([
      this.read<RawCredit>("getCredit", [id]),
      this.read<readonly DocRequirement[]>("getDocs", [id]),
      this.read<
        readonly { amount: bigint; requiredDocs: number; satisfiedDocs: number; waivedDocs: number; settled: boolean }[]
      >(
        "getTranches",
        [id],
      ),
    ]);
    if (c.status === Status.None) throw new Error(`credit ${id} does not exist`);
    const hashes = await Promise.all(
      t.flatMap((_, ti) => d.map((__, di) => this.read<Hex>("presentedHash", [id, BigInt(ti * 8 + di)]))),
    );
    const zero = `0x${"0".repeat(64)}`;
    return {
      id,
      ...c,
      status: c.status as Status,
      applicantAgent: c.applicantAgent === 0n ? null : c.applicantAgent - 1n,
      beneficiaryAgent: c.beneficiaryAgent === 0n ? null : c.beneficiaryAgent - 1n,
      partner: c.partner === zeroAddress ? null : c.partner,
      docs: d.map((x) => ({ docType: x.docType, attestor: x.attestor, label: docLabel(x.docType) })),
      tranches: t.map((tr, ti) => ({
        amount: tr.amount,
        requiredDocs: tr.requiredDocs,
        satisfiedDocs: tr.satisfiedDocs,
        waivedDocs: tr.waivedDocs,
        settled: tr.settled,
        documents: d.map((_, di) => {
          const required = (tr.requiredDocs & (1 << di)) !== 0;
          const satisfied = (tr.satisfiedDocs & (1 << di)) !== 0;
          const h = hashes[ti * d.length + di]!;
          return { doc: di, required, satisfied, hash: h === zero ? null : h, waived: (tr.waivedDocs & (1 << di)) !== 0 };
        }),
      })),
    };
  }

  /** Credits where `party` is applicant or beneficiary, from CreditOpened logs. */
  async listCredits(party: Address, fromBlock: bigint = 0n): Promise<bigint[]> {
    const event = documentaryCreditAbi.find((x) => x.type === "event" && x.name === "CreditOpened")!;
    const [asApplicant, asBeneficiary] = await Promise.all([
      this.publicClient.getLogs({ address: this.address, event: event as never, args: { applicant: party } as never, fromBlock }),
      this.publicClient.getLogs({ address: this.address, event: event as never, args: { beneficiary: party } as never, fromBlock }),
    ]);
    const ids = new Set<bigint>();
    for (const l of [...asApplicant, ...asBeneficiary]) ids.add((l as unknown as { args: { creditId: bigint } }).args.creditId);
    return [...ids].sort((a, b) => (a < b ? -1 : 1));
  }

  /**
   * Track record of an ERC-8004 agent, counting only feedback written by this contract. The registry is open to
   * anyone, so filtering by client is what restricts the history to real settlements through this contract.
   * Two wallets of one person can still trade with each other: weigh the record by volume and attestor diversity.
   */
  async reputation(
    agentId: bigint,
    symbol: "USDC" | "EURC" = "USDC",
    registry: Address = ARC.reputationRegistry,
  ): Promise<Reputation> {
    const q = (tag2: string) =>
      this.publicClient.readContract({
        address: registry,
        abi: reputationAbi,
        functionName: "getSummary",
        args: [agentId, [this.address], "credoc", tag2],
      });
    const [d, w, e, c, ac, v, skipped] = await Promise.all([
      q("delivered"),
      q("waived"),
      q("expired"),
      q("cancelled"),
      q("assignee-cancelled"),
      q(`volume-${symbol}`),
      this.read<bigint>("skippedFeedback", [agentId]),
    ]);
    const delivered = Number(d[0]);
    const expired = Number(e[0]);
    const cancelled = Number(c[0]);
    const assigneeCancelled = Number(ac[0]);
    const judged = delivered + expired + cancelled + assigneeCancelled;
    return {
      delivered,
      waived: Number(w[0]),
      expired,
      cancelled,
      assigneeCancelled,
      skipped: Number(skipped),
      onTimeRate: judged === 0 ? null : delivered / judged,
      averageTicket: v[0] === 0n ? null : BigInt(v[1]),
    };
  }

  // ---- plans (CredocPass)

  /** The plans contract this credit contract reads, or null if plans are off. */
  async passAddress(): Promise<Address | null> {
    const a = await this.read<Address>("pass", []);
    return a === zeroAddress ? null : a;
  }

  /** End date, state and current price of each plan for `account`, plus the verified-attestor badge. */
  async plans(account: Address): Promise<PlanStatus | null> {
    const pass = await this.passAddress();
    if (!pass) return null;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const rd = <T>(functionName: string, args: readonly unknown[]) =>
      this.publicClient.readContract({ address: pass, abi: passAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
    const names = Object.keys(PLAN) as PlanName[];
    const [untils, prices, verified] = await Promise.all([
      Promise.all(names.map((n) => rd<bigint>("activeUntil", [account, PLAN[n]]))),
      Promise.all(names.map((n) => rd<bigint>("price", [PLAN[n]]))),
      rd<boolean>("verified", [account]),
    ]);
    const out = { verified } as PlanStatus;
    names.forEach((n, i) => (out[n] = { until: untils[i]!, active: untils[i]! >= now, price: prices[i]! }));
    return out;
  }

  /** Buy or extend a plan for `account` (default: the connected wallet), approving the USDC if needed. */
  async buyPlan(plan: PlanName, periods: number, account?: Address): Promise<{ until: bigint; hash: Hex }> {
    const pass = await this.passAddress();
    if (!pass) throw new Error("plans are not enabled on this contract");
    const rd = <T>(functionName: string, args: readonly unknown[]) =>
      this.publicClient.readContract({ address: pass, abi: passAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
    const [cost, usdc] = await Promise.all([rd<bigint>("quote", [PLAN[plan], periods]), rd<Address>("usdc", [])]);
    const allowance = await this.publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.w.account.address, pass],
    });
    if (allowance < cost) {
      const h = await this.w.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [pass, cost],
        chain: this.w.chain,
        account: this.w.account,
      });
      if ((await this.receipt(h)).status !== "success") throw new Error(`approve reverted: ${h}`);
    }
    const { request } = await this.publicClient.simulateContract({
      address: pass,
      abi: passAbi,
      functionName: "buy",
      args: [account ?? this.w.account.address, PLAN[plan], periods],
      account: this.w.account,
    });
    const hash = await this.w.writeContract(request);
    const receipt = await this.receipt(hash);
    if (receipt.status !== "success") throw new Error(`buy reverted: ${hash}`);
    const [ev] = parseEventLogs({ abi: passAbi, eventName: "PassBought", logs: receipt.logs });
    if (!ev) throw new Error("PassBought event not found");
    return { until: ev.args.until, hash };
  }

  /** Register an ERC-8004 identity for the connected wallet; returns its agentId. */
  async registerAgent(agentURI: string, registry: Address = ARC.identityRegistry): Promise<bigint> {
    const hash = await this.w.writeContract({
      address: registry,
      abi: identityAbi,
      functionName: "register",
      args: [agentURI],
      chain: this.w.chain,
      account: this.w.account,
    });
    const receipt = await this.receipt(hash);
    const [ev] = parseEventLogs({ abi: identityAbi, eventName: "Registered", logs: receipt.logs });
    if (!ev) throw new Error("Registered event not found");
    return ev.args.agentId;
  }
}
