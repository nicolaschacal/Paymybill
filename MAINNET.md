# Going to mainnet: checklist

Do these in order. Nothing here is done automatically.

## 1. Money you need

Program rent is locked while the program exists (recoverable only by closing the program). Solana is cutting the rent rate in five steps (SIMD-0437), so this number keeps falling. Formula: `(binary bytes + 173) x lamports_per_byte`.

- Measured on devnet today: the current ~224 KB build holds **1.137 SOL** (5,080 lamports per byte, the step-2 rate).
- Mainnet followed the same schedule (step 2 reported live in September 2026), but confirm the live rate right before deploying: `solana rent 223640 --url mainnet-beta`.
- Steps 3 to 5 are expected with Agave 4.4 (about November 2026, no fixed date): 2,575 / 1,322 / 696 lamports per byte, which would make the same program cost about 0.58 / 0.30 / 0.16 SOL.

| Item | Amount |
| --- | --- |
| Program rent (locked) | about 1.14 SOL today, about 0.16 SOL once the rent cut is complete |
| Temporary buffer during deploy (refunded) | about the same again, returned when the deploy ends |
| Fees and margin | 0.05 SOL |
| **Have in the deploy wallet** | **about 2.5 SOL** today (1.14 + 1.14 + margin) |
| Fee wallet starting balance (must never reach 0) | 0.01 SOL or more |
| Paid RPC (Helius, Triton, QuickNode...) | their monthly plan |
| Domain `paymybill.fun` | registrar price |

## 2. Keys (the most important part)

- Create a **new fee wallet** controlled by a hardware wallet (or Squads) and put its address in `FEE_WALLET` in `lib.rs`. The current one is the devnet admin wallet that lives in GitHub.
- **Upgrade authority = hardware wallet or Squads multisig**, never the GitHub secret. Deploy from your own computer:
  ```
  solana program deploy target/deploy/paymybill.so --url mainnet-beta \
    --keypair <ledger or deploy wallet> --program-id <new program keypair> \
    --upgrade-authority <squads vault or ledger address>
  ```
  Keep the new program keypair offline until the deploy finishes, then you can discard it.
- Enable 2FA (hardware key if possible) on GitHub, Vercel, the domain registrar and the email that owns them. Turn on branch protection for `main`.
- Never put a mainnet key in GitHub secrets.

## 3. Code changes for mainnet

1. New program id: `declare_id!` in `lib.rs`, `Anchor.toml`, `VITE_PROGRAM_ID`, `app/src/chain.ts` default, `agents.md`, `llms.txt`, `security-tests/tests/common/mod.rs`.
2. New `FEE_WALLET` (above), also in `chain.ts`, `agents.md`, tests.
3. `anchor build`, then run the security suite again (Actions > devnet-ops > `security`).
4. Vercel env: `VITE_CLUSTER=mainnet-beta`, `VITE_RPC_URL=<your paid RPC>`, `VITE_PROGRAM_ID=<new id>`, `VITE_SITE_URL=https://paymybill.fun`.
5. Connect `paymybill.fun` in Vercel and check `/agents.md`, `/llms.txt` and the link preview card.

## 4. Before opening to the public

- [ ] Independent audit (strongly recommended) or at least a second reviewer of `lib.rs` and `security-tests/`.
- [ ] Deploy, then run a real payment with small amounts from two of your own wallets. Check: split 97/3, receipt, supporter card, close and refund.
- [ ] Test with real wallets in the browser (Phantom, Solflare, Backpack), on desktop and mobile.
- [ ] Fund the fee wallet (>= 0.01 SOL).
- [ ] Tell users clearly: payments are final, deposits are refundable, handles are unverified.
- [ ] Decide on the upgrade policy: keep the multisig, or make the program immutable once it is stable (`solana program set-upgrade-authority --final`).
