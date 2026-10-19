# paymybill.fun

Post a bill. A stranger pays it. Wallet to wallet on Solana, no servers.

Create a profile-less bill ("Electricity, October — 0.06 SOL"), share the link, and anyone can pay it in one transaction. The SOL goes straight from the payer to the creator and the bill flips to **paid**.

## How it stays onchain

- **One PDA per bill, one receipt PDA per (bill, payer) and one optional supporter PDA per payer.** No global registry, no counter, no user profile, no escrow, no token accounts. The bill id is a random `u64` picked by the client, so no counter account is needed.
- **Seeds:** `["bill", creator, id_le_bytes]`. Fixed size: 322 bytes (≈0.003 SOL rent, refunded when the creator closes the bill).
- **Non-custodial:** `pay_bill` does a System Program transfer payer → creator and stamps the bill in the same transaction. The program never holds funds.
- **No backend:** the app is a static site. Bills are listed with `getProgramAccounts` (filtered by size, discriminator and creator) straight from an RPC.

### Instructions

| Instruction | Who | What |
| --- | --- | --- |
| `create_bill(id, amount, title, note)` | creator | Creates the bill PDA (title ≤ 48 bytes, note ≤ 160 bytes). `amount` is the target. |
| `pay_bill(amount, name, handle)` | anyone but the creator | Chips in `amount` (≥ 0.001 SOL, or whatever is left; never more than what is left). The payer sends exactly `amount`: 97% goes to the creator and 3% to the fee wallet, atomically. When `raised` reaches the target the bill flips to paid. Creates or updates the payer's receipt and supporter card; optional `name` (≤ 24 bytes) and X `handle` (≤ 15 chars) are stored on the card. |
| `close_bill()` | creator | Closes an open or paid bill and refunds the rent. Money already contributed stays with the creator and payers keep their receipts. |
| `close_receipt()` | payer | Closes the receipt and refunds its deposit. |
| `set_supporter(name, handle)` | anyone | Creates or edits the supporter card without paying. |
| `close_supporter()` | owner | Deletes the card (and its leaderboard position) and refunds the deposit. |

### Leaderboards

The supporter card holds lifetime and per-UTC-day totals. Clients build **All time** and **Today** (resets at 00:00 UTC) with one `getProgramAccounts` over supporter accounts (sliced to ~70 bytes each), then fetch full cards only for the top rows. Ties go to whoever reached the total first. Closing a card removes the wallet from the boards.

### For agents

There is no server and no HTTP API, so agents pay the program directly with their own wallet. `app/public/agents.md` (served at `/agents.md`, with `/llms.txt` as an index) documents the accounts, instruction formats and safety rules, and `app/agent/cli.ts` is a ready-to-run CLI: `npm run agent -- list | board [--today] | me | pay <bill> <sol|rest> [--name N] [--handle H]`.

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

Locally, `cargo test --lib` checks the layout and discriminators the frontend relies on. The `e2e` action runs `app/agent/e2e.ts` against devnet: it funds three throwaway wallets from the admin wallet, creates a bill, pays it in parts, checks the fee split, receipts, leaderboards and error cases, closes everything and sweeps the leftovers back.

### App

```bash
cd app
cp .env.example .env      # set VITE_PROGRAM_ID to the program id in Anchor.toml
npm install
npm run dev
```

Deploy `app/` as a static site (for example Vercel with root directory `app`). Routing uses real paths (`/b/…`, `/mine`), so the host must serve `index.html` for unknown paths; `app/vercel.json` does that on Vercel.

Share links look like `/b/my-dog-vet-4xKp2mQ9vRt`: a cosmetic slug of the title plus the bill's random id in base58, resolved with one filtered `getProgramAccounts`. `/b/<address>` and the old `/#/b/<address>` links keep working. If two bills ever share an id (someone copying it), the page lists both with their poster addresses instead of picking one.

Link previews (X, Telegram, …) use the tags in `app/index.html` and `app/public/og.png`. They need an absolute site URL: set `VITE_SITE_URL` (for example `https://paymybill.fun`) in the build environment.

Set `VITE_RPC_URL` to your own RPC for real use: public endpoints rate-limit `getProgramAccounts`.

## Security

See [SECURITY.md](SECURITY.md) (what was attacked, findings, what is not covered) and [MAINNET.md](MAINNET.md) (costs and checklist). Adversarial tests live in `security-tests/` and run from Actions > devnet-ops > `security`.

## Things to know

- A 3% service fee is deducted from what the creator receives (`FEE_BPS` and `FEE_WALLET` in the program, mirrored in `app/src/chain.ts`); the payer pays exactly the bill amount. Creators can tick "add the fee on top" when posting to net the full amount. Changing the fee wallet or rate needs a program upgrade.
- Anyone can post any bill. The UI says so and payments are final, so only pay people you want to help.
- The frontend encodes instructions by hand (no generated IDL). The discriminators and account layout are pinned by the Rust tests in `programs/paymybill/src/lib.rs`; if you change the program, update `app/src/chain.ts` to match.
- The program id in the repo is a placeholder until the first `deploy` run commits the real one.
