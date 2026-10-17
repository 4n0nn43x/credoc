import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";

/** Contract custom errors in the words of a trader, with what to do next. */
const HUMAN: Record<string, string> = {
  TokenNotAllowed: "Only USDC and EURC can be used.",
  BadParams: "Some terms are invalid. Check amounts, expiry and attestors.",
  NotActive: "This credit is already closed.",
  Unauthorized: "Your wallet is not allowed to do this on this credit.",
  Expired: "This credit has expired. Ask the other party to extend it before it lapses next time.",
  NotExpired: "This credit has not expired yet. Funds can be reclaimed after the expiry date.",
  AlreadySatisfied: "This document was already presented or accepted.",
  NotRequired: "This shipment does not require that document.",
  BadSignature: "The signature does not match the nominated attestor.",
  SignatureExpired: "This signed presentation has expired. Ask the attestor to sign again.",
  OfferUnavailable: "This offer is no longer available.",
  StaleOffer: "Part of the credit was paid since this offer was made. The financier needs to price it again.",
  NothingOwed: "Nothing is waiting to be withdrawn.",
  AlreadyLinked: "This wallet already has an identity linked. The link is per address and cannot be changed.",
  InsufficientGas: "Not enough gas was provided. Retry, your wallet will estimate it again.",
};

/** Plain-English message for a contract error name (as returned by the relayer), if known. */
export const contractErrorMessage = (name: string): string | undefined => HUMAN[name];

export function humanError(e: unknown): string {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return "Signature cancelled. Nothing was sent.";
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    if (name && HUMAN[name]) return HUMAN[name];
    if (/insufficient funds/i.test(e.message)) return "Not enough USDC in this wallet to pay the network fee.";
    if (/ERC20InsufficientAllowance|transfer amount exceeds/i.test(e.message)) return "Not enough balance for this amount.";
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}
