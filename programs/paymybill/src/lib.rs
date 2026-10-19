//! paymybill.fun — post a bill, let a stranger pay it.
//!
//! Design goals:
//!   * No servers: all state lives on Solana.
//!   * Minimal accounts: exactly ONE PDA per bill. No global registry,
//!     no counters, no user profiles, no escrow, no token accounts.
//!   * Non-custodial: funds go straight from the payer to the creator's
//!     wallet inside the same transaction that marks the bill as paid.
//!   * Receipt: paying also creates a receipt PDA owned by the payer (a copy of
//!     the bill, seeds ["receipt", bill]). Creator keeps the bill, payer keeps the
//!     receipt, and each can close their own copy independently.
//!   * Service fee: FEE_BPS (3%) of the bill amount is taken out of what the
//!     creator receives and sent to FEE_WALLET in that same transaction. The
//!     payer always pays exactly the bill amount.
//!
//! A bill PDA is derived from `["bill", creator, id_le_bytes]`, where `id` is a
//! random u64 picked by the client (so no counter account is needed).

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("6LgTZEVfPX2a3ouR9suAaozexXNjyJ8S4EqNRYFKX8x3");

pub const TITLE_MAX: usize = 48;
pub const NOTE_MAX: usize = 160;

/// Service fee in basis points (300 = 3%), deducted from what the creator receives.
pub const FEE_BPS: u64 = 300;

/// Wallet that receives the service fee. Changing it needs a program upgrade.
pub const FEE_WALLET: Pubkey = pubkey!("AQfKYtAVyZARgKxSt6ZpqwLAtDNeE1LF8Jk5FYWteqbv");

/// Fee owed on a bill of `amount` lamports (rounded down).
pub fn fee_for(amount: u64) -> u64 {
    ((amount as u128) * (FEE_BPS as u128) / 10_000u128) as u64
}

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_PAID: u8 = 1;

#[program]
pub mod paymybill {
    use super::*;

    /// Publish a bill. The creator funds the (refundable) rent of the bill account.
    pub fn create_bill(
        ctx: Context<CreateBill>,
        id: u64,
        amount: u64,
        title: String,
        note: String,
    ) -> Result<()> {
        require!(amount > 0, BillError::ZeroAmount);
        require!(
            !title.trim().is_empty() && title.len() <= TITLE_MAX,
            BillError::BadTitle
        );
        require!(note.len() <= NOTE_MAX, BillError::NoteTooLong);

        let bill = &mut ctx.accounts.bill;
        bill.status = STATUS_OPEN;
        bill.bump = ctx.bumps.bill;
        bill.creator = ctx.accounts.creator.key();
        bill.id = id;
        bill.amount = amount;
        bill.created_at = Clock::get()?.unix_timestamp;
        bill.paid_at = 0;
        bill.payer = Pubkey::default();
        bill.title = title;
        bill.note = note;
        Ok(())
    }

    /// Pay an open bill in full. The payer sends exactly `amount`: the creator
    /// receives `amount - fee` and FEE_WALLET receives `fee`, atomically, and
    /// the bill is stamped as paid. The program never holds funds.
    pub fn pay_bill(ctx: Context<PayBill>) -> Result<()> {
        let amount = ctx.accounts.bill.amount;
        let fee = fee_for(amount);
        let to_creator = amount - fee; // fee <= amount always (3%)

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.creator.to_account_info(),
                },
            ),
            to_creator,
        )?;

        if fee > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.fee_wallet.to_account_info(),
                    },
                ),
                fee,
            )?;
        }

        let now = Clock::get()?.unix_timestamp;
        let bill = &mut ctx.accounts.bill;
        bill.status = STATUS_PAID;
        bill.payer = ctx.accounts.payer.key();
        bill.paid_at = now;

        // The payer's own copy of the bill: survives if the creator closes theirs.
        let receipt = &mut ctx.accounts.receipt;
        receipt.bump = ctx.bumps.receipt;
        receipt.payer = ctx.accounts.payer.key();
        receipt.creator = bill.creator;
        receipt.bill = bill.key();
        receipt.amount = bill.amount;
        receipt.paid_at = now;
        receipt.title = bill.title.clone();
        receipt.note = bill.note.clone();
        Ok(())
    }

    /// Payer-only. Removes the receipt and refunds its deposit to the payer.
    pub fn close_receipt(_ctx: Context<CloseReceipt>) -> Result<()> {
        Ok(())
    }

    /// Creator-only. Cancels an open bill or tidies up a paid one, and gets
    /// the rent back.
    pub fn close_bill(_ctx: Context<CloseBill>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateBill<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Bill::INIT_SPACE,
        seeds = [b"bill", creator.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub bill: Account<'info, Bill>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayBill<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"bill", bill.creator.as_ref(), &bill.id.to_le_bytes()],
        bump = bill.bump,
        constraint = bill.status == STATUS_OPEN @ BillError::AlreadyPaid,
        constraint = payer.key() != bill.creator @ BillError::SelfPay,
    )]
    pub bill: Account<'info, Bill>,
    /// CHECK: must equal the creator stored in the bill; it only receives SOL.
    #[account(mut, address = bill.creator)]
    pub creator: UncheckedAccount<'info>,
    /// CHECK: must be the hard-coded FEE_WALLET; it only receives SOL.
    #[account(mut, address = FEE_WALLET @ BillError::WrongFeeWallet)]
    pub fee_wallet: UncheckedAccount<'info>,
    /// The payer's receipt. The deposit (rent) is paid by the payer and is refunded on close.
    #[account(
        init,
        payer = payer,
        space = 8 + Receipt::INIT_SPACE,
        seeds = [b"receipt", bill.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseReceipt<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, close = payer, has_one = payer)]
    pub receipt: Account<'info, Receipt>,
}

#[derive(Accounts)]
pub struct CloseBill<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, close = creator, has_one = creator)]
    pub bill: Account<'info, Bill>,
}

/// Field order matters: the client reads these at fixed offsets and filters
/// `getProgramAccounts` by `status` (offset 8, right after the discriminator).
#[account]
#[derive(InitSpace)]
pub struct Bill {
    /// 0 = open, 1 = paid
    pub status: u8,
    pub bump: u8,
    pub creator: Pubkey,
    pub id: u64,
    /// Lamports the payer must send to the creator.
    pub amount: u64,
    pub created_at: i64,
    pub paid_at: i64,
    pub payer: Pubkey,
    #[max_len(TITLE_MAX)]
    pub title: String,
    #[max_len(NOTE_MAX)]
    pub note: String,
}

/// The payer's copy of a paid bill. Offsets are read by the client:
/// bump 8, payer 9, creator 41, bill 73, amount 105, paid_at 113, title 121.
#[account]
#[derive(InitSpace)]
pub struct Receipt {
    pub bump: u8,
    pub payer: Pubkey,
    pub creator: Pubkey,
    pub bill: Pubkey,
    pub amount: u64,
    pub paid_at: i64,
    #[max_len(TITLE_MAX)]
    pub title: String,
    #[max_len(NOTE_MAX)]
    pub note: String,
}

#[error_code]
pub enum BillError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Title must be 1-48 bytes")]
    BadTitle,
    #[msg("Note must be at most 160 bytes")]
    NoteTooLong,
    #[msg("This bill has already been paid")]
    AlreadyPaid,
    #[msg("You cannot pay your own bill")]
    SelfPay,
    #[msg("Fee wallet account does not match the program's fee wallet")]
    WrongFeeWallet,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::Discriminator;

    /// These constants are hard-coded in app/src/chain.ts. If this test fails,
    /// the frontend encoding is out of sync with the program.
    #[test]
    fn client_constants_match_program() {
        assert_eq!(Bill::DISCRIMINATOR, &[0x46, 0x4c, 0xfb, 0xaf, 0xd4, 0xe3, 0xd4, 0xb3][..]);
        assert_eq!(
            crate::instruction::CreateBill::DISCRIMINATOR,
            &[0x1c, 0xf1, 0xb4, 0xa1, 0x6d, 0xff, 0xdc, 0x2c][..]
        );
        assert_eq!(
            crate::instruction::PayBill::DISCRIMINATOR,
            &[0xfa, 0xea, 0xbc, 0x6e, 0x1f, 0xb9, 0x22, 0x05][..]
        );
        assert_eq!(
            crate::instruction::CloseBill::DISCRIMINATOR,
            &[0xed, 0x6c, 0x97, 0x43, 0xf9, 0x53, 0xf7, 0xfa][..]
        );
        assert_eq!(8 + Bill::INIT_SPACE, 322);
        assert_eq!(Receipt::DISCRIMINATOR, &[0x27, 0x9a, 0x49, 0x6a, 0x50, 0x66, 0x91, 0x99][..]);
        assert_eq!(
            crate::instruction::CloseReceipt::DISCRIMINATOR,
            &[0x7e, 0xfe, 0xf4, 0xcb, 0x7c, 0xa4, 0x86, 0x59][..]
        );
        assert_eq!(8 + Receipt::INIT_SPACE, 337);
    }

    #[test]
    fn receipt_layout_matches_client() {
        let (payer, creator, bill) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let r = Receipt {
            bump: 253,
            payer,
            creator,
            bill,
            amount: 5,
            paid_at: 99,
            title: "Rent".to_string(),
            note: "May".to_string(),
        };
        let mut d = Vec::new();
        r.try_serialize(&mut d).unwrap();
        assert_eq!(d[8], 253);
        assert_eq!(&d[9..41], payer.as_ref());
        assert_eq!(&d[41..73], creator.as_ref());
        assert_eq!(&d[73..105], bill.as_ref());
        assert_eq!(u64::from_le_bytes(d[105..113].try_into().unwrap()), 5);
        assert_eq!(i64::from_le_bytes(d[113..121].try_into().unwrap()), 99);
        assert_eq!(u32::from_le_bytes(d[121..125].try_into().unwrap()), 4);
        assert_eq!(&d[125..129], b"Rent");
        assert_eq!(u32::from_le_bytes(d[129..133].try_into().unwrap()), 3);
        assert_eq!(&d[133..136], b"May");
    }

    #[test]
    fn fee_is_three_percent_rounded_down() {
        assert_eq!(fee_for(1_000_000_000), 30_000_000);
        assert_eq!(fee_for(62_000_000), 1_860_000);
        assert_eq!(fee_for(33), 0);
        assert_eq!(fee_for(34), 1);
        assert_eq!(fee_for(u64::MAX), (u64::MAX as u128 * 300 / 10_000) as u64);
    }

    #[test]
    fn layout_offsets_match_client() {
        let creator = Pubkey::new_unique();
        let payer = Pubkey::new_unique();
        let bill = Bill {
            status: STATUS_PAID,
            bump: 254,
            creator,
            id: 7,
            amount: 1_000_000_000,
            created_at: 111,
            paid_at: 222,
            payer,
            title: "Electric".to_string(),
            note: "March".to_string(),
        };
        let mut data = Vec::new();
        bill.try_serialize(&mut data).unwrap();
        assert_eq!(data[8], STATUS_PAID);
        assert_eq!(data[9], 254);
        assert_eq!(&data[10..42], creator.as_ref());
        assert_eq!(u64::from_le_bytes(data[42..50].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(data[50..58].try_into().unwrap()), 1_000_000_000);
        assert_eq!(i64::from_le_bytes(data[58..66].try_into().unwrap()), 111);
        assert_eq!(i64::from_le_bytes(data[66..74].try_into().unwrap()), 222);
        assert_eq!(&data[74..106], payer.as_ref());
        assert_eq!(u32::from_le_bytes(data[106..110].try_into().unwrap()), 8);
        assert_eq!(&data[110..118], b"Electric");
        // note length follows the title bytes directly (borsh, no padding)
        assert_eq!(u32::from_le_bytes(data[118..122].try_into().unwrap()), 5);
        assert_eq!(&data[122..127], b"March");
    }
}
