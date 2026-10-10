import { createPublicClient, http } from "viem";
import { Credoc } from "@credoc/sdk";
import { CREDOC_ADDRESS, chain } from "../../shared/config";

export const publicClient = createPublicClient({ chain, transport: http(undefined, { batch: true }) });

/** Read-only client; writes go through useTx(), which builds one bound to the connected wallet. */
export const reader = CREDOC_ADDRESS ? new Credoc(publicClient as never, CREDOC_ADDRESS) : null;
