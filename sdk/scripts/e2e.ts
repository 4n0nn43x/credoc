/**
 * End-to-end story of a documentary credit, against a local fork of Arc mainnet:
 *   arc-anvil --fork-url https://rpc.mainnet.arc.io --chain-id 5042
 *   npm run e2e
 * Uses the real native USDC, the real ERC-8004 registries, Memo and Multicall3From.
 */
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  formatUnits,
  http,
  keccak256,
  parseUnits,
  stringToHex,
  toBytes,
  type Address,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arc } from "viem/chains";
import {
  ARC,
  Credoc,
  docType,
  docs,
  documentaryCreditAbi,
  documentaryCreditBytecode,
  hashDocument,
  quoteAssignment,
  signPresentation,
} from "../src/index.ts";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const chain = { ...arc, rpcUrls: { default: { http: [RPC] } } };
const transport = http(RPC);
const pub = createPublicClient({ chain, transport });
const testClient = createTestClient({ chain, transport, mode: "anvil" });

// fresh keys: the well-known anvil keys carry an EIP-7702 delegation on Arc mainnet (a public sweeper),
// which makes ERC-8004 `register` (_safeMint) revert. Parties get native USDC through anvil_setBalance.
const wallet = (k: `0x${string}`) => createWalletClient({ account: privateKeyToAccount(k), chain, transport });
const importerW = wallet(generatePrivateKey());
const exporterW = wallet(generatePrivateKey());
const financierW = wallet(generatePrivateKey());
const relayerW = wallet(generatePrivateKey());
// attestors are brand-new keys with zero balance: they only sign, never pay gas
const forwarderW = wallet(generatePrivateKey());
const inspectorW = wallet(generatePrivateKey());

const usd = (x: bigint) => `${formatUnits(x, 6)} USDC`;
const bal = (a: Address) =>
  pub.readContract({
    address: ARC.usdc,
    abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [a],
  });
const step = (s: string) => console.log(`\n=== ${s}`);
const now = async () => (await pub.getBlock()).timestamp;

async function main() {
  if ((await pub.getChainId()) !== 5042) throw new Error("expected a fork of Arc mainnet (chainId 5042)");

  for (const w of [importerW, exporterW, financierW, relayerW]) {
    await testClient.setBalance({ address: w.account.address, value: parseUnits("5000", 18) }); // 5000 USDC, native 18 decimals
  }

  step("Deploy DocumentaryCredit");
  const deployHash = await importerW.deployContract({
    abi: documentaryCreditAbi,
    bytecode: documentaryCreditBytecode,
    args: [[ARC.usdc, ARC.eurc], ARC.identityRegistry, ARC.reputationRegistry, importerW.account.address, 25],
  });
  const address = (await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress!;
  console.log("contract", address);
  const as = (w: typeof importerW) => new Credoc(pub, address, w);
  const importer = as(importerW);
  const exporter = as(exporterW);
  const financier = as(financierW);
  const relayer = as(relayerW);

  step("Importer and exporter register ERC-8004 identities");
  const importerAgent = await importer.registerAgent("https://credoc.example/agents/importer.json");
  const exporterAgent = await exporter.registerAgent("https://credoc.example/agents/exporter.json");
  console.log({ importerAgent, exporterAgent });

  step("Importer opens a credit in ONE transaction (Multicall3From: approve + Memo-tagged open)");
  const ref = "PO-2026-0042";
  const t0 = await now();
  const { id, hash: openHash } = await importer.open(
    {
      beneficiary: exporterW.account.address,
      token: ARC.usdc,
      expiry: t0 + 30n * 86400n,
      terms: hashDocument(toBytes("Proforma PI-889: 2 containers of cashew nuts, CIF Cotonou")),
      applicantAgent: importerAgent,
      docs: [
        { docType: docType("BILL_OF_LADING"), attestor: forwarderW.account.address },
        { docType: docType("INSPECTION_CERTIFICATE"), attestor: inspectorW.account.address },
      ],
      tranches: [
        { amount: parseUnits("600", 6), requiredDocs: docs(0, 1) }, // container 1: B/L + inspection
        { amount: parseUnits("400", 6), requiredDocs: docs(0) }, // container 2: B/L only
      ],
    },
    ref,
  );
  const openReceipt = await pub.getTransactionReceipt({ hash: openHash });
  const memoLog = openReceipt.logs.find((l) => l.address.toLowerCase() === ARC.memo.toLowerCase() && l.topics.length === 4);
  console.log(`credit #${id} opened, locked ${usd(await bal(address))}, memoId indexed: ${memoLog?.topics[3] === keccak256(stringToHex(ref))}`);

  await exporter.linkAgent(exporterAgent); // once for its address: every credit to it now counts

  step("Financier prices the receivable from the exporter's onchain track record and makes an offer");
  const rep0 = await financier.reputation(exporterAgent);
  const credit = await financier.getCredit(id);
  const quote = quoteAssignment({ outstanding: credit.outstanding, daysToExpiry: 30, reputation: rep0 });
  console.log("exporter history:", rep0, `quote ${usd(quote.price)} at ${(quote.annualRate * 100).toFixed(1)}%/yr`);
  const { offerId } = await financier.makeOffer(id, quote.price, (await now()) + 86400n);

  step("Exporter sells the proceeds before shipping and gets paid now");
  const exporterBefore = await bal(exporterW.account.address);
  await exporter.acceptOffer(offerId);
  console.log("exporter received", usd((await bal(exporterW.account.address)) - exporterBefore), "before shipping (net of the gas it paid, in USDC)");

  step("Forwarder and inspector sign offchain (zero balance, no gas); a relayer submits");
  const dl = (await now()) + 3600n;
  const bl1 = hashDocument(toBytes("bill of lading MSCU1234567"));
  const insp = hashDocument(toBytes("SGS inspection report 77-A"));
  const s1 = await signPresentation(forwarderW, address, 5042, { creditId: id, tranche: 0, doc: 0, docHash: bl1, deadline: dl });
  const s2 = await signPresentation(inspectorW, address, 5042, { creditId: id, tranche: 0, doc: 1, docHash: insp, deadline: dl });
  const finBefore = await bal(financierW.account.address);
  await relayer.relay(s1);
  await relayer.relay(s2);
  console.log("tranche 0 settled, financier collected", usd((await bal(financierW.account.address)) - finBefore));
  console.log("attestor balances:", await bal(forwarderW.account.address), await bal(inspectorW.account.address));

  step("Second container ships");
  const bl2 = hashDocument(toBytes("bill of lading MSCU7654321"));
  await relayer.relay(await signPresentation(forwarderW, address, 5042, { creditId: id, tranche: 1, doc: 0, docHash: bl2, deadline: dl }));
  const view = await financier.getCredit(id);
  console.log(`credit #${id} status=${view.status === 2 ? "Closed" : "Active"} outstanding=${usd(view.outstanding)}`);
  const collected = (await bal(financierW.account.address)) - finBefore;
  console.log(`financier paid ${usd(quote.price)}, collected ${usd(collected)}, earned ${usd(collected - quote.price)}`);

  step("A second credit is never shipped and expires");
  const { id: id2 } = await importer.open(
    {
      beneficiary: exporterW.account.address,
      token: ARC.usdc,
      expiry: (await now()) + 7n * 86400n,
      terms: hashDocument(toBytes("PO-2026-0043")),
      docs: [{ docType: docType("BILL_OF_LADING"), attestor: forwarderW.account.address }],
      tranches: [{ amount: parseUnits("250", 6), requiredDocs: docs(0) }],
    },
    "PO-2026-0043",
  );
  await testClient.increaseTime({ seconds: 8 * 86400 });
  await testClient.mine({ blocks: 1 });
  const impBefore = await bal(importerW.account.address);
  await relayer.reclaim(id2); // any keeper can close it; funds go back to the importer
  console.log(`credit #${id2} reclaimed, importer refunded ${usd((await bal(importerW.account.address)) - impBefore)}`);

  step("Exporter's track record (only feedback written by this contract during settlements)");
  const rep = await financier.reputation(exporterAgent);
  console.log(rep);
  const q2 = quoteAssignment({ outstanding: parseUnits("1000", 6), daysToExpiry: 30, reputation: rep });
  console.log(`next 1000 USDC receivable would price at ${usd(q2.price)} (${(q2.annualRate * 100).toFixed(1)}%/yr)`);

  if (rep.delivered !== 2 || rep.expired !== 1 || rep.waived !== 0) throw new Error("unexpected reputation");
  if (view.status !== 2) throw new Error("credit should be closed");
  console.log("\nE2E OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
