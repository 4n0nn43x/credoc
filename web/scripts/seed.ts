/**
 * Local demo: deploys DocumentaryCredit on an arc-anvil fork of Arc mainnet and plays ~35 days of realistic
 * activity with the demo personas, then writes web/.env.local so the dashboard points at it.
 *
 *   arc-anvil --fork-url https://rpc.mainnet.arc.io --chain-id 5042
 *   npm run seed
 *
 * Refuses to run against anything but a local RPC: persona keys are public.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseUnits,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "viem/chains";
import {
  ARC,
  Credoc,
  docType,
  docs,
  documentaryCreditAbi,
  documentaryCreditBytecode,
  hashDocument,
  signPresentation,
} from "@credoc/sdk";
import { type PersonaId, personaAddress, personaKey } from "../src/shared/demo.ts";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(RPC)) throw new Error("seed only runs against a local fork");

const chain = { ...arc, rpcUrls: { default: { http: [RPC] } } };
const transport = http(RPC);
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: "anvil" });
const EURC_WHALE = "0xbe080aC37ad1305DFCc9521F5e6F68CFDc41B7fa" as Address;
const DAY = 86_400;

const wallet = (id: PersonaId) => createWalletClient({ account: privateKeyToAccount(personaKey(id)), chain, transport });
const usdc = (x: string) => parseUnits(x, 6);
const now = async () => (await pub.getBlock()).timestamp;
const advance = async (days: number) => {
  await test.increaseTime({ seconds: Math.round(days * DAY) });
  await test.mine({ blocks: 1 });
};
const fileHash = (label: string) => hashDocument(toBytes(label));

async function main() {
  if ((await pub.getChainId()) !== 5042) throw new Error("expected an arc-anvil fork of Arc mainnet (chainId 5042)");

  for (const id of ["importer", "exporter", "exporter2", "financier", "relayer"] as const) {
    await test.setBalance({ address: personaAddress(id), value: parseUnits("250000", 18) }); // native USDC
  }
  // EURC for the importer and the financier, from a real holder on the fork
  await test.impersonateAccount({ address: EURC_WHALE });
  await test.setBalance({ address: EURC_WHALE, value: parseUnits("10", 18) });
  const whale = createWalletClient({ account: EURC_WHALE, chain, transport });
  for (const [to, amt] of [["importer", "20000"], ["financier", "15000"]] as const) {
    await pub.waitForTransactionReceipt({
      hash: await whale.writeContract({
        address: ARC.eurc,
        abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
        functionName: "transfer",
        args: [personaAddress(to), usdc(amt)],
      }),
    });
  }
  await test.stopImpersonatingAccount({ address: EURC_WHALE });

  const deployer = wallet("relayer");
  const deployHash = await deployer.deployContract({
    abi: documentaryCreditAbi,
    bytecode: documentaryCreditBytecode,
    args: [[ARC.usdc, ARC.eurc], ARC.identityRegistry, ARC.reputationRegistry],
  });
  const deployed = await pub.waitForTransactionReceipt({ hash: deployHash });
  const address = deployed.contractAddress!;
  console.log("DocumentaryCredit", address, "block", deployed.blockNumber);

  const as = (id: PersonaId) => new Credoc(pub as never, address, wallet(id) as never);
  const importer = as("importer");
  const exporter = as("exporter");
  const exporter2 = as("exporter2");
  const financier = as("financier");
  const relayer = as("relayer");
  const fwd = wallet("forwarder");
  const insp = wallet("inspector");
  const FWD = personaAddress("forwarder");
  const INSP = personaAddress("inspector");

  const agents = {
    importer: await importer.registerAgent("https://credoc.app/agents/cotonou-foods.json"),
    exporter: await exporter.registerAgent("https://credoc.app/agents/mekong-cashew.json"),
    exporter2: await exporter2.registerAgent("https://credoc.app/agents/accra-cocoa.json"),
  };

  const attest = async (signer: typeof fwd, creditId: bigint, tranche: number, doc: number, label: string) => {
    const s = await signPresentation(signer as never, address, 5042, {
      creditId,
      tranche,
      doc,
      docHash: fileHash(label),
      deadline: (await now()) + 3600n,
    });
    await relayer.relay(s);
  };
  const bl = { docType: docType("BILL_OF_LADING"), attestor: FWD };
  const ins = { docType: docType("INSPECTION_CERTIFICATE"), attestor: INSP };

  // ---- C1: delivered on time (history)
  const c1 = await importer.open(
    {
      beneficiary: personaAddress("exporter"),
      token: ARC.usdc,
      expiry: (await now()) + BigInt(20 * DAY),
      terms: fileHash("PI-2026-0811 raw cashew nuts W320, 1 x 20ft, CIF Cotonou"),
      applicantAgent: agents.importer,
      docs: [bl],
      tranches: [{ amount: usdc("4800"), requiredDocs: docs(0) }],
    },
    "PO-2026-0811",
  );
  await exporter.linkBeneficiaryAgent(c1.id, agents.exporter);
  await advance(2.3);
  await attest(fwd, c1.id, 0, 0, "B/L MEKO2608114");

  // ---- C2: exporter never ships, expires, refunded (history)
  await advance(3);
  const c2 = await importer.open(
    {
      beneficiary: personaAddress("exporter"),
      token: ARC.usdc,
      expiry: (await now()) + BigInt(7 * DAY),
      terms: fileHash("PI-2026-0829 cashew kernels WW240, 1 x 20ft"),
      applicantAgent: agents.importer,
      docs: [bl],
      tranches: [{ amount: usdc("2500"), requiredDocs: docs(0) }],
    },
    "PO-2026-0829",
  );
  await exporter.linkBeneficiaryAgent(c2.id, agents.exporter);
  await advance(8);
  await relayer.reclaim(c2.id);

  // ---- C3: two containers, both delivered (history)
  await advance(2);
  const c3 = await importer.open(
    {
      beneficiary: personaAddress("exporter"),
      token: ARC.usdc,
      expiry: (await now()) + BigInt(30 * DAY),
      terms: fileHash("PI-2026-0905 raw cashew nuts W320, 2 x 40ft"),
      applicantAgent: agents.importer,
      docs: [bl, ins],
      tranches: [
        { amount: usdc("7200"), requiredDocs: docs(0, 1) },
        { amount: usdc("4800"), requiredDocs: docs(0) },
      ],
    },
    "PO-2026-0905",
  );
  await exporter.linkBeneficiaryAgent(c3.id, agents.exporter);
  await advance(3);
  await attest(fwd, c3.id, 0, 0, "B/L MEKO2609051");
  await attest(insp, c3.id, 0, 1, "Inspection report DI-55120");
  await advance(4);
  await attest(fwd, c3.id, 1, 0, "B/L MEKO2609052");

  // ---- C4: cocoa in EURC, open, with a financier's offer waiting for the exporter
  await advance(5);
  const c4 = await importer.open(
    {
      beneficiary: personaAddress("exporter2"),
      token: ARC.eurc,
      expiry: (await now()) + BigInt(40 * DAY),
      terms: fileHash("PI-ACT-2610 cocoa beans grade I, 1 x 20ft, FOB Tema"),
      applicantAgent: agents.importer,
      docs: [bl, ins],
      tranches: [{ amount: usdc("8000"), requiredDocs: docs(0, 1) }],
    },
    "PO-2026-1002",
  );
  await exporter2.linkBeneficiaryAgent(c4.id, agents.exporter2);
  await advance(1);
  await financier.makeOffer(c4.id, usdc("7790"), (await now()) + BigInt(10 * DAY));

  // ---- C5: the showcase. Financed before shipping, first container documents half in.
  await advance(2);
  const c5 = await importer.open(
    {
      beneficiary: personaAddress("exporter"),
      token: ARC.usdc,
      expiry: (await now()) + BigInt(45 * DAY),
      terms: fileHash("PI-2026-1004 raw cashew nuts W320, 2 x 40ft, CIF Cotonou"),
      applicantAgent: agents.importer,
      docs: [bl, ins],
      tranches: [
        { amount: usdc("15000"), requiredDocs: docs(0, 1) },
        { amount: usdc("10000"), requiredDocs: docs(0) },
      ],
    },
    "PO-2026-1004",
  );
  await exporter.linkBeneficiaryAgent(c5.id, agents.exporter);
  await advance(0.5);
  const { offerId } = await financier.makeOffer(c5.id, usdc("24480"), (await now()) + BigInt(5 * DAY));
  await advance(0.2);
  await exporter.acceptOffer(offerId);
  await advance(3);
  await attest(fwd, c5.id, 0, 0, "B/L MEKO2610041");

  // ---- C6: fresh credit, nothing shipped yet
  await advance(1);
  const c6 = await importer.open(
    {
      beneficiary: personaAddress("exporter"),
      token: ARC.usdc,
      expiry: (await now()) + BigInt(30 * DAY),
      terms: fileHash("PI-2026-1009 cashew kernels WW320, 1 x 20ft"),
      applicantAgent: agents.importer,
      docs: [bl],
      tranches: [{ amount: usdc("6000"), requiredDocs: docs(0) }],
    },
    "PO-2026-1009",
  );

  const env = [
    "# written by `npm run seed` for the local arc-anvil fork; persona keys are public, never use on mainnet",
    "VITE_NETWORK=local",
    `VITE_RPC_URL=${RPC}`,
    `VITE_CREDOC_ADDRESS=${address}`,
    `VITE_CREDOC_FROM_BLOCK=${deployed.blockNumber}`,
    `RELAYER_KEY=${personaKey("relayer")}`,
    "",
  ].join("\n");
  writeFileSync(resolve(import.meta.dirname, "../.env.local"), env);
  console.log(`seeded credits ${[c1, c2, c3, c4, c5, c6].map((c) => c.id).join(", ")}, wrote web/.env.local`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

