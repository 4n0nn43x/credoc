/**
 * Attestor CLI: fingerprint a document and sign its presentation offchain (no gas, no funds needed).
 *
 *   ATTESTOR_KEY=0x... npm run attest -- --contract 0x.. --credit 1 --tranche 0 --doc 0 --file ./bl.pdf
 *
 * Prints a JSON SignedPresentation. Add --relay with RELAYER_KEY set to submit it right away.
 * Env RPC_URL defaults to Arc mainnet.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "viem/chains";
import { Credoc, hashDocument, signPresentation } from "../src/index.ts";

const { values: a } = parseArgs({
  options: {
    contract: { type: "string" },
    credit: { type: "string" },
    tranche: { type: "string" },
    doc: { type: "string" },
    file: { type: "string" },
    ttl: { type: "string", default: "86400" },
    relay: { type: "boolean", default: false },
  },
});

const need = (k: keyof typeof a) => {
  const v = a[k];
  if (v === undefined || v === "") throw new Error(`missing --${k}`);
  return String(v);
};
const key = (name: string) => {
  const k = process.env[name];
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} must be a 0x-prefixed private key`);
  return k as `0x${string}`;
};

const contract = need("contract");
if (!isAddress(contract)) throw new Error("--contract is not an address");
const rpc = process.env.RPC_URL ?? arc.rpcUrls.default.http[0];
const chain = { ...arc, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });
const attestor = createWalletClient({ account: privateKeyToAccount(key("ATTESTOR_KEY")), chain, transport: http(rpc) });

const docHash = hashDocument(readFileSync(need("file")));
const deadline = BigInt(Math.floor(Date.now() / 1000)) + BigInt(need("ttl"));
const signed = await signPresentation(attestor, contract, await pub.getChainId(), {
  creditId: BigInt(need("credit")),
  tranche: Number(need("tranche")),
  doc: Number(need("doc")),
  docHash,
  deadline,
});
console.log(JSON.stringify(signed, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

if (a.relay) {
  const relayer = createWalletClient({ account: privateKeyToAccount(key("RELAYER_KEY")), chain, transport: http(rpc) });
  const hash = await new Credoc(pub, contract, relayer).relay(signed);
  console.error(`relayed: ${hash}`);
}
