# paymybill.fun

Post a bill. A stranger pays it. Wallet to wallet on Solana, no servers.

Create a profile-less bill ("Electricity, October — 0.06 SOL"), share the link, and anyone can pay it in one transaction. The SOL goes straight from the payer to the creator and the bill flips to **paid**.

## How it stays onchain

- **One PDA per bill, nothing else.** No global registry, no counter, no user profile, no escrow, no token accounts. The bill id is a random `u64` picked by the client, so no counter account is needed.
- **Seeds:** `["bill", creator, id_le_bytes]`. Fixed size: 322 bytes (≈0.003 SOL rent, refunded when the creator closes the bill).
- **Non-custodial:** `pay_bill` does a System Program transfer payer → creator and stamps the bill in the same transaction. The program never holds funds.
- **No backend:** the app is a static site. Bills are listed with `getProgramAccounts` (filtered by size, discriminator and creator) straight from an RPC.

### Instructions

| Instruction | Who | What |
| --- | --- | --- |
| `create_bill(id, amount, title, note)` | creator | Creates the bill PDA (title ≤ 48 bytes, note ≤ 160 bytes). |
| `pay_bill()` | anyone but the creator | Transfers `amount` lamports to the creator and marks the bill paid. |
| `close_bill()` | creator | Closes an open or paid bill and refunds the rent. |

Amounts are in SOL. The UI can take USD and converts at the current rate when posting (rate from Coinbase's public API; only a convenience, the bill is priced in SOL).

## Repo layout

```
programs/paymybill/   Anchor program (Rust)
app/                  Vite + React static frontend
```

## Run it

### Program (GitHub Actions, devnet)

Build and deploy run in the `devnet-ops` workflow (Actions tab → devnet-ops → Run workflow). The admin wallet is the repo secret `ADMIN_KEYPAIR` (the keypair JSON, pasted in Settings → Secrets and variables → Actions); CI writes it to a temporary file and it is never committed.

1. `airdrop` funds the admin wallet with devnet SOL (or send some to it yourself).
2. `deploy` builds and deploys. The first run creates the program address, writes it into the repo and commits it; later runs upgrade the same program.
3. `status` shows the wallet balance and the deployed program.

Locally, `cargo test --lib` checks the layout and discriminators the frontend relies on.

### App

```bash
cd app
cp .env.example .env      # set VITE_PROGRAM_ID to the program id in Anchor.toml
npm install
npm run dev
```

Deploy `app/` as a static site (for example Vercel with root directory `app`). Routing uses `#/…`, so no rewrite rules are needed.

Set `VITE_RPC_URL` to your own RPC for real use: public endpoints rate-limit `getProgramAccounts`.

## Things to know

- Anyone can post any bill. The UI says so and payments are final, so only pay people you want to help.
- The frontend encodes instructions by hand (no generated IDL). The discriminators and account layout are pinned by the Rust tests in `programs/paymybill/src/lib.rs`; if you change the program, update `app/src/chain.ts` to match.
- The program id in the repo is a placeholder until the first `deploy` run commits the real one.
