use crate::{error::RuinError, state::*};
use anchor_lang::prelude::*;
use anchor_spl::{
    token::{Mint as QuoteMint, Token, TokenAccount as QuoteAccount},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

#[derive(Accounts)]
pub struct UpgradeGuard<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = deployment.programdata_address()? == Some(program_data.key()) @ RuinError::NotUpgradeAuthority)]
    pub deployment: Program<'info, crate::program::Ruin>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ RuinError::NotUpgradeAuthority)]
    pub program_data: Box<Account<'info, ProgramData>>,
}
#[derive(Accounts)]
pub struct PostGuard<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}
#[derive(Accounts)]
pub struct IdleGuard<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"house", &house.id.to_le_bytes()], bump = house.bump,
        constraint = house.state == HouseState::Idle @ RuinError::NotIdle)]
    pub house: Box<Account<'info, House>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Init<'info> {
    pub guard: UpgradeGuard<'info>,
    #[account(init, payer = guard.authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: validated as a classic six-decimal mint before use.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: validated oracle layout, owner and asset.
    pub sol_feed: UncheckedAccount<'info>,
    /// CHECK: validated oracle layout, owner and asset.
    pub btc_feed: UncheckedAccount<'info>,
    /// CHECK: validated oracle layout, owner and asset.
    pub eth_feed: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetRuin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ RuinError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: validated mint layout, owner and extensions.
    pub ruin_mint: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ RuinError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetFeed<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ RuinError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: validated oracle layout, owner and asset.
    pub feed: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct PostHouse<'info> {
    pub guard: PostGuard<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = house_space(&guard.config, id)?, seeds = [b"house".as_ref(), id.to_le_bytes().as_ref()], bump)]
    pub house: Box<Account<'info, House>>,
    #[account(address = guard.config.quote_mint @ RuinError::WrongMint)]
    pub quote_mint: Box<Account<'info, QuoteMint>>,
    #[account(init, payer = owner, seeds = [b"house_vault", house.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = house, token::token_program = token_program)]
    pub vault: Box<Account<'info, QuoteAccount>>,
    #[account(mut, constraint = source.mint == guard.config.quote_mint @ RuinError::WrongMint,
        constraint = source.owner == owner.key() @ RuinError::WrongOwner)]
    pub source: Box<Account<'info, QuoteAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(constraint = Some(ruin_mint.key()) == guard.config.ruin_mint @ RuinError::WrongMint)]
    pub ruin_mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(constraint = Some(ruin_token_program.key()) == guard.config.ruin_token_program @ RuinError::UnsupportedTokenProgram)]
    pub ruin_token_program: Option<Interface<'info, TokenInterface>>,
    #[account(init_if_needed, payer = owner, seeds = [b"lock_vault", house.key().as_ref()], bump,
        token::mint = ruin_mint, token::authority = house, token::token_program = ruin_token_program)]
    pub lock_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, constraint = ruin_account.mint == guard.config.ruin_mint.ok_or(RuinError::RuinNotSet)? @ RuinError::WrongMint,
        constraint = ruin_account.owner == owner.key() @ RuinError::WrongOwner)]
    pub ruin_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct TopUp<'info> {
    pub guard: IdleGuard<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(address = guard.config.quote_mint @ RuinError::WrongMint)]
    pub quote_mint: Box<Account<'info, QuoteMint>>,
    #[account(mut, seeds = [b"house_vault", guard.house.key().as_ref()], bump = guard.house.vault_bump,
        token::mint = quote_mint, token::authority = guard.house)]
    pub vault: Box<Account<'info, QuoteAccount>>,
    #[account(mut, constraint = source.mint == guard.config.quote_mint @ RuinError::WrongMint,
        constraint = source.owner == owner.key() @ RuinError::WrongOwner)]
    pub source: Box<Account<'info, QuoteAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(constraint = Some(ruin_mint.key()) == guard.config.ruin_mint @ RuinError::WrongMint)]
    pub ruin_mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(constraint = Some(ruin_token_program.key()) == guard.config.ruin_token_program @ RuinError::UnsupportedTokenProgram)]
    pub ruin_token_program: Option<Interface<'info, TokenInterface>>,
    #[account(init_if_needed, payer = owner, seeds = [b"lock_vault", guard.house.key().as_ref()], bump,
        token::mint = ruin_mint, token::authority = guard.house, token::token_program = ruin_token_program)]
    pub lock_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, constraint = ruin_account.mint == guard.config.ruin_mint.ok_or(RuinError::RuinNotSet)? @ RuinError::WrongMint,
        constraint = ruin_account.owner == owner.key() @ RuinError::WrongOwner)]
    pub ruin_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"house", &house.id.to_le_bytes()], bump = house.bump)]
    pub house: Box<Account<'info, House>>,
    #[account(address = config.quote_mint @ RuinError::WrongMint)]
    pub quote_mint: Box<Account<'info, QuoteMint>>,
    #[account(mut, seeds = [b"house_vault", house.key().as_ref()], bump = house.vault_bump,
        constraint = vault.mint == config.quote_mint @ RuinError::WrongMint,
        constraint = vault.owner == house.key() @ RuinError::WrongOwner)]
    pub vault: Box<Account<'info, QuoteAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(mut, constraint = destination.mint == config.quote_mint @ RuinError::WrongMint,
        constraint = destination.owner == owner.key() @ RuinError::WrongOwner)]
    pub destination: Box<Account<'info, QuoteAccount>>,
    #[account(constraint = Some(ruin_mint.key()) == config.ruin_mint @ RuinError::WrongMint)]
    pub ruin_mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(constraint = Some(ruin_token_program.key()) == config.ruin_token_program @ RuinError::UnsupportedTokenProgram)]
    pub ruin_token_program: Option<Interface<'info, TokenInterface>>,
    #[account(mut, seeds = [b"lock_vault", house.key().as_ref()], bump,
        token::mint = ruin_mint, token::authority = house, token::token_program = ruin_token_program)]
    pub lock_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, constraint = ruin_account.mint == config.ruin_mint.ok_or(RuinError::RuinNotSet)? @ RuinError::WrongMint,
        constraint = ruin_account.owner == owner.key() @ RuinError::WrongOwner)]
    pub ruin_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetAccepting<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"house", &house.id.to_le_bytes()], bump = house.bump)]
    pub house: Box<Account<'info, House>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct CloseHouse<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, close = owner, seeds = [b"house", &house.id.to_le_bytes()], bump = house.bump)]
    pub house: Box<Account<'info, House>>,
    #[account(address = config.quote_mint @ RuinError::WrongMint)]
    pub quote_mint: Box<Account<'info, QuoteMint>>,
    #[account(mut, seeds = [b"house_vault", house.key().as_ref()], bump = house.vault_bump,
        constraint = vault.mint == config.quote_mint @ RuinError::WrongMint,
        constraint = vault.owner == house.key() @ RuinError::WrongOwner)]
    pub vault: Box<Account<'info, QuoteAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(mut, constraint = destination.mint == config.quote_mint @ RuinError::WrongMint,
        constraint = destination.owner == owner.key() @ RuinError::WrongOwner)]
    pub destination: Box<Account<'info, QuoteAccount>>,
    #[account(constraint = Some(ruin_mint.key()) == config.ruin_mint @ RuinError::WrongMint)]
    pub ruin_mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(constraint = Some(ruin_token_program.key()) == config.ruin_token_program @ RuinError::UnsupportedTokenProgram)]
    pub ruin_token_program: Option<Interface<'info, TokenInterface>>,
    #[account(mut, seeds = [b"lock_vault", house.key().as_ref()], bump,
        token::mint = ruin_mint, token::authority = house, token::token_program = ruin_token_program)]
    pub lock_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, constraint = ruin_account.mint == config.ruin_mint.ok_or(RuinError::RuinNotSet)? @ RuinError::WrongMint,
        constraint = ruin_account.owner == owner.key() @ RuinError::WrongOwner)]
    pub ruin_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct RequestOpen<'info> {
    pub guard: IdleGuard<'info>,
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(init, payer = trader, space = 8 + Table::INIT_SPACE,
        seeds = [b"table", guard.house.key().as_ref(), &guard.house.next_seq.to_le_bytes()], bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(address = guard.config.quote_mint @ RuinError::WrongMint)]
    pub quote_mint: Box<Account<'info, QuoteMint>>,
    #[account(mut, seeds = [b"house_vault", guard.house.key().as_ref()], bump = guard.house.vault_bump,
        token::mint = quote_mint, token::authority = guard.house)]
    pub vault: Box<Account<'info, QuoteAccount>>,
    #[account(mut, constraint = source.mint == guard.config.quote_mint @ RuinError::WrongMint,
        constraint = source.owner == trader.key() @ RuinError::WrongOwner)]
    pub source: Box<Account<'info, QuoteAccount>>,
    /// CHECK: validated configured feed.
    pub feed: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct FillOpen<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"house", &house.id.to_le_bytes()], bump = house.bump)]
    pub house: Box<Account<'info, House>>,
    #[account(mut, seeds = [b"table", house.key().as_ref(), &table.seq.to_le_bytes()], bump = table.bump,
        has_one = house, constraint = house.state == HouseState::Busy && house.current_seq == table.seq @ RuinError::NotLive)]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: validated configured feed.
    pub feed: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct RefundOpen<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"house", &house.id.to_le_bytes()], bump = house.bump)]
    pub house: Box<Account<'info, House>>,
    #[account(mut, close = trader, seeds = [b"table", house.key().as_ref(), &table.seq.to_le_bytes()], bump = table.bump,
        has_one = house, constraint = house.state == HouseState::Busy && house.current_seq == table.seq @ RuinError::NotLive)]
    pub table: Box<Account<'info, Table>>,
    #[account(address = config.quote_mint @ RuinError::WrongMint)]
    pub quote_mint: Box<Account<'info, QuoteMint>>,
    #[account(mut, seeds = [b"house_vault", house.key().as_ref()], bump = house.vault_bump,
        constraint = vault.mint == config.quote_mint @ RuinError::WrongMint,
        constraint = vault.owner == house.key() @ RuinError::WrongOwner)]
    pub vault: Box<Account<'info, QuoteAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(mut, constraint = destination.mint == config.quote_mint @ RuinError::WrongMint,
        constraint = destination.owner == table.trader @ RuinError::WrongOwner)]
    pub destination: Box<Account<'info, QuoteAccount>>,
    /// CHECK: bound rent recipient.
    #[account(mut, address = table.trader @ RuinError::ReceiverMismatch)]
    pub trader: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct RequestClose<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"house", &house.id.to_le_bytes()], bump = house.bump)]
    pub house: Box<Account<'info, House>>,
    #[account(mut, seeds = [b"table", house.key().as_ref(), &table.seq.to_le_bytes()], bump = table.bump,
        has_one = house, constraint = house.state == HouseState::Busy && house.current_seq == table.seq @ RuinError::NotLive)]
    pub table: Box<Account<'info, Table>>,
    pub trader: Signer<'info>,
    /// CHECK: validated configured feed.
    pub feed: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"house", &house.id.to_le_bytes()], bump = house.bump)]
    pub house: Box<Account<'info, House>>,
    #[account(mut, close = trader, seeds = [b"table", house.key().as_ref(), &table.seq.to_le_bytes()], bump = table.bump,
        has_one = house, constraint = house.state == HouseState::Busy && house.current_seq == table.seq @ RuinError::NotLive)]
    pub table: Box<Account<'info, Table>>,
    #[account(address = config.quote_mint @ RuinError::WrongMint)]
    pub quote_mint: Box<Account<'info, QuoteMint>>,
    #[account(mut, seeds = [b"house_vault", house.key().as_ref()], bump = house.vault_bump,
        constraint = vault.mint == config.quote_mint @ RuinError::WrongMint,
        constraint = vault.owner == house.key() @ RuinError::WrongOwner)]
    pub vault: Box<Account<'info, QuoteAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(mut, constraint = destination.mint == config.quote_mint @ RuinError::WrongMint,
        constraint = destination.owner == table.trader @ RuinError::WrongOwner)]
    pub destination: Option<Box<Account<'info, QuoteAccount>>>,
    /// CHECK: bound rent recipient.
    #[account(mut, address = table.trader @ RuinError::ReceiverMismatch)]
    pub trader: UncheckedAccount<'info>,
    /// CHECK: validated configured feed.
    pub feed: UncheckedAccount<'info>,
}

#[cfg(feature = "devnet")]
#[event_cpi]
#[derive(Accounts)]
#[instruction(market: u8)]
pub struct DevFeedInit<'info> {
    pub guard: UpgradeGuard<'info>,
    /// CHECK: raw oracle layout initialized by this instruction.
    #[account(init, payer = guard.authority, space = 394, seeds = [b"dev_feed".as_ref(), market.to_le_bytes().as_ref()], bump)]
    pub feed: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "devnet")]
#[event_cpi]
#[derive(Accounts)]
#[instruction(market: u8)]
pub struct DevFeedWrite<'info> {
    pub guard: UpgradeGuard<'info>,
    /// CHECK: raw oracle layout, PDA and owner constrained.
    #[account(mut, seeds = [b"dev_feed".as_ref(), market.to_le_bytes().as_ref()], bump, owner = crate::ID)]
    pub feed: UncheckedAccount<'info>,
}
