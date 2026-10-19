/**
 * End-to-end test against a real cluster (devnet by default), using the same instruction
 * builders and decoders as the website. It funds three throwaway wallets from E2E_FUNDER,
 * runs the whole flow, cleans up (closing everything to get deposits back) and sweeps the
 * leftovers back to the funder.
 *
 *   E2E_FUNDER=/path/to/keypair.json npx tsx agent/e2e.ts
 *
 * Exit code 1 if any check fails.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  FEE_WALLET,
  RPC_URL,
  closeBillIx,
  closeReceiptIx,
  closeSupporterIx,
  createBillIx,
  deriveReceipt,
  deriveSupporter,
  feeFor,
  fetchBill,
  fetchBillsById,
  fetchReceipt,
  fetchReceiptsForBill,
  fetchSupporter,
  listBillRefs,
  listSupporterRefs,
  payBillIx,
  randomId,
  rankAllTime,
  rankToday,
  setSupporterIx,
  utcDay,
} from "../src/chain";
import { billPath, idToCode, parseBillParam } from "../src/lib";
import { loadKeypair, sendIxs, short } from "./lib";

const conn = new Connection(RPC_URL, "confirmed");
const funder = loadKeypair(process.env.E2E_FUNDER);
const lam = (sol: number) => BigInt(Math.round(sol * LAMPORTS_PER_SOL));
const bal = async (k: PublicKey) => BigInt(await conn.getBalance(k, "confirmed"));

let failed = 0;
const log: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`;
  log.push(line);
  console.log(line);
}
async function expectFail(name: string, p: Promise<unknown>) {
  try {
    await p;
    check(name, false, "it succeeded but should have failed");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, true, msg.replace(/\s+/g, " ").slice(0, 110));
  }
}

async function main() {
  console.log(`RPC ${RPC_URL}\nfunder ${funder.publicKey.toBase58()} balance ${Number(await bal(funder.publicKey)) / 1e9} SOL`);
  const creator = Keypair.generate();
  const b1 = Keypair.generate();
  const c1 = Keypair.generate();
  const wallets = [creator, b1, c1];

  // fund the throwaway wallets
  const fund = async (to: Keypair, sol: number) =>
    sendIxs(conn, funder, [
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to.publicKey, lamports: lam(sol) }),
    ]);
  await fund(creator, 0.02);
  await fund(b1, 0.05);
  await fund(c1, 0.05);
  console.log(`funded creator ${short(creator.publicKey)}, B ${short(b1.publicKey)}, C ${short(c1.publicKey)}`);

  try {
    // ---------- bill 1: 0.02 SOL target, two payers ----------
    const id1 = randomId();
    const target = lam(0.02);
    const title = `e2e ${new Date().toISOString().slice(0, 16)}`;
    const { ix, bill: billPk } = createBillIx(creator.publicKey, id1, target, title, "automated test");
    await sendIxs(conn, creator, [ix]);
    let bill = (await fetchBill(conn, billPk))!;
    check("bill created", !!bill && bill.lamports === target && bill.raised === 0n && !bill.paid && bill.title === title);

    // short link resolves to the same bill
    const path = billPath({ title, id: id1 });
    const parsed = parseBillParam(path.split("/").pop()!);
    const byId = parsed && parsed.kind === "id" ? await fetchBillsById(conn, parsed.id) : [];
    check("friendly link resolves", byId.length === 1 && byId[0].address.equals(billPk), path + " -> " + idToCode(id1));

    const open = await listBillRefs(conn, 0);
    check("bill is in the open index", open.some((r) => r.address.equals(billPk)));

    // rejected payments
    await expectFail("creator cannot pay own bill", sendIxs(conn, creator, [payBillIx(creator.publicKey, bill, lam(0.005))]));
    await expectFail("below minimum is rejected", sendIxs(conn, b1, [payBillIx(b1.publicKey, bill, 100_000n)]));
    await expectFail("more than remaining is rejected", sendIxs(conn, b1, [payBillIx(b1.publicKey, bill, lam(0.03))]));
    await expectFail(
      "hidden/direction-override characters in a title are rejected",
      sendIxs(conn, creator, [createBillIx(creator.publicKey, randomId(), target, "pay\u202Ethis", "x").ix]),
    );
    await expectFail("bad handle is rejected", sendIxs(conn, b1, [payBillIx(b1.publicKey, bill, lam(0.005), "x", "not valid!")]));

    // B pays 0.005 (partial)
    const creatorBefore = await bal(creator.publicKey);
    const feeBefore = await bal(FEE_WALLET);
    const pay1 = lam(0.005);
    await sendIxs(conn, b1, [payBillIx(b1.publicKey, bill, pay1, "E2E Bee", "e2e_bee")]);
    bill = (await fetchBill(conn, billPk))!;
    check("partial: raised and still open", bill.raised === pay1 && !bill.paid && bill.backers === 1, `raised ${bill.raised}`);
    check("partial: creator got amount minus 3% fee", (await bal(creator.publicKey)) - creatorBefore === pay1 - feeFor(pay1));
    check("partial: fee wallet got the 3% fee", (await bal(FEE_WALLET)) - feeBefore === feeFor(pay1), `fee ${feeFor(pay1)}`);
    const rB = await fetchReceipt(conn, deriveReceipt(billPk, b1.publicKey));
    check("receipt created for B", !!rB && rB.lamports === pay1 && rB.payer.equals(b1.publicKey) && rB.title === title);
    const sB = await fetchSupporter(conn, b1.publicKey);
    check(
      "supporter card created for B",
      !!sB && sB.total === pay1 && sB.dayTotal === pay1 && sB.day === utcDay() && sB.name === "E2E Bee" && sB.handle === "e2e_bee" && sB.billsHelped === 1,
    );

    // B adds more to the same bill: receipt grows, backers does not
    const pay1b = lam(0.003);
    await sendIxs(conn, b1, [payBillIx(b1.publicKey, bill, pay1b)]);
    bill = (await fetchBill(conn, billPk))!;
    const rB2 = await fetchReceipt(conn, deriveReceipt(billPk, b1.publicKey));
    const sB2 = await fetchSupporter(conn, b1.publicKey);
    check("repeat payer: receipt accumulates, backers stays 1", rB2!.lamports === pay1 + pay1b && bill.backers === 1 && bill.raised === pay1 + pay1b);
    check("repeat payer: name kept when left empty, billsHelped stays 1", sB2!.name === "E2E Bee" && sB2!.billsHelped === 1 && sB2!.total === pay1 + pay1b);

    // C pays the rest
    const rest = bill.lamports - bill.raised;
    await sendIxs(conn, c1, [payBillIx(c1.publicKey, bill, rest, "E2E Cee", "")]);
    bill = (await fetchBill(conn, billPk))!;
    check("final payment completes the bill", bill.paid && bill.raised === bill.lamports && bill.backers === 2 && bill.paidAt > 0);
    await expectFail("paid bill rejects more payments", sendIxs(conn, b1, [payBillIx(b1.publicKey, bill, lam(0.001))]));
    const receipts = await fetchReceiptsForBill(conn, billPk);
    check("two receipts listed for the bill", receipts.length === 2);
    const paidIdx = await listBillRefs(conn, 1);
    check("bill moved to the paid index", paidIdx.some((r) => r.address.equals(billPk)));

    // leaderboards
    const refs = await listSupporterRefs(conn);
    const all = rankAllTime(refs).map((r) => r.owner.toBase58());
    const today = rankToday(refs).map((r) => r.owner.toBase58());
    const iB = all.indexOf(b1.publicKey.toBase58());
    const iC = all.indexOf(c1.publicKey.toBase58());
    check("both payers on the all-time board", iB >= 0 && iC >= 0);
    check("today board has both", today.includes(b1.publicKey.toBase58()) && today.includes(c1.publicKey.toBase58()));
    check("ranking order follows totals (B paid 0.008, C paid 0.012)", iC < iB, `C #${iC + 1}, B #${iB + 1}`);

    // ---------- set_supporter without paying ----------
    await sendIxs(conn, c1, [setSupporterIx(c1.publicKey, "E2E Cee v2", "cee_v2")]);
    const sC = await fetchSupporter(conn, c1.publicKey);
    check("set_supporter edits the card", sC!.name === "E2E Cee v2" && sC!.handle === "cee_v2" && sC!.total === rest);
    await expectFail("set_supporter validates handle", sendIxs(conn, c1, [setSupporterIx(c1.publicKey, "ok", "bad handle")]));

    // ---------- cleanup: each side closes its own copy ----------
    await sendIxs(conn, creator, [closeBillIx(creator.publicKey, billPk)]);
    check("creator closed the bill", (await fetchBill(conn, billPk)) === null);
    const rBAfter = await fetchReceipt(conn, deriveReceipt(billPk, b1.publicKey));
    check("receipt survives the bill being closed", !!rBAfter && rBAfter.lamports === pay1 + pay1b);
    await expectFail("someone else cannot close B's receipt", sendIxs(conn, c1, [closeReceiptIx(c1.publicKey, deriveReceipt(billPk, b1.publicKey))]));
    await sendIxs(conn, b1, [closeReceiptIx(b1.publicKey, deriveReceipt(billPk, b1.publicKey)), closeSupporterIx(b1.publicKey)]);
    await sendIxs(conn, c1, [closeReceiptIx(c1.publicKey, deriveReceipt(billPk, c1.publicKey)), closeSupporterIx(c1.publicKey)]);
    check(
      "receipts and cards closed",
      (await fetchReceipt(conn, deriveReceipt(billPk, b1.publicKey))) === null &&
        (await fetchSupporter(conn, b1.publicKey)) === null &&
        (await fetchSupporter(conn, c1.publicKey)) === null,
    );
    check("closed card leaves the leaderboard", !rankAllTime(await listSupporterRefs(conn)).some((r) => r.owner.equals(b1.publicKey)));
    void deriveSupporter;
  } finally {
    // sweep whatever is left back to the funder
    for (const w of wallets) {
      try {
        const b = await bal(w.publicKey);
        if (b > 10_000n) await sendIxs(conn, w, [SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: funder.publicKey, lamports: b - 5_000n })]);
      } catch (e) {
        console.log("sweep failed for", short(w.publicKey), e instanceof Error ? e.message : e);
      }
    }
    console.log(`funder balance after: ${Number(await bal(funder.publicKey)) / 1e9} SOL`);
  }

  console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : failed + " CHECK(S) FAILED"} (${log.length} checks)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E crashed:", e instanceof Error ? e.stack || e.message : e);
  process.exit(1);
});
