import { createPublicClient, http } from "viem";
import { Credoc } from "@credoc/sdk";
import { CREDOC_ADDRESS, chain } from "../../shared/config";

// Arc finalizes in under a second: poll every 500 ms (viem's default of 4 s would hide that finality from the user)
export const publicClient = createPublicClient({ chain, transport: http(undefined, { batch: true }), pollingInterval: 500 });

/** Read-only client; writes go through useTx(), which builds one bound to the connected wallet. */
export const reader = CREDOC_ADDRESS ? new Credoc(publicClient as never, CREDOC_ADDRESS) : null;
