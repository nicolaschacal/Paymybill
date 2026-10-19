/** Shared helpers for the agent CLI and the e2e script (Node only). */
import { Connection, Keypair, Transaction, TransactionInstruction, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { readFileSync, existsSync } from "node:fs";

/** AGENT_KEYPAIR (or the given value) can be a path to a keypair JSON file, a JSON array, or a base58 secret key. */
export function loadKeypair(value: string | undefined): Keypair {
  if (!value) throw new Error("Set AGENT_KEYPAIR to a keypair file path, a JSON array or a base58 secret key.");
  let raw = value.trim();
  if (existsSync(raw)) raw = readFileSync(raw, "utf8").trim();
  const secret = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  return Keypair.fromSecretKey(secret);
}

export async function sendIxs(
  conn: Connection,
  signer: Keypair,
  ixs: TransactionInstruction[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(signer);
  const signature = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  // Poll instead of using websocket subscriptions: more robust on public RPCs and in CI.
  for (;;) {
    const st = (await conn.getSignatureStatuses([signature])).value[0];
    if (st?.err) throw new Error("Transaction failed: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return signature;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error("Transaction expired before confirming. Try again.");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export const sol = (lamports: bigint | number) => Number(lamports) / 1e9;
export const short = (k: PublicKey) => k.toBase58().slice(0, 4) + "…" + k.toBase58().slice(-4);
