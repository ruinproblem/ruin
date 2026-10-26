use crate::state::*;
use anchor_lang::prelude::*;
#[event]
pub struct Initialized {
    pub admin: Pubkey,
    pub quote_mint: Pubkey,
    pub markets: [Market; 3],
    pub lev_min: u16,
    pub lev_max: u16,
    pub k_min: u8,
    pub k_max: u8,
    pub e_min_bps: u16,
    pub e_max_bps: u16,
    pub expiry_secs: u32,
    pub m_min: u64,
    pub free_stake: u64,
    pub ruin_per_usd: u64,
    pub delay_min: u16,
    pub delay_max: u16,
    pub fill_window: u16,
    pub close_window: u16,
    pub stale_secs: u32,
}
#[event]
pub struct RuinSet {
    pub ruin_mint: Pubkey,
    pub ruin_token_program: Pubkey,
}
#[event]
pub struct ParamsSet {
    pub m_min: u64,
    pub free_stake: u64,
    pub ruin_per_usd: u64,
    pub delay_min: u16,
    pub delay_max: u16,
    pub fill_window: u16,
    pub close_window: u16,
    pub stale_secs: u32,
}
#[event]
pub struct FeedSet {
    pub market: u8,
    pub old_feed: Pubkey,
    pub new_feed: Pubkey,
}
#[event]
pub struct HousePosted {
    pub house: Pubkey,
    pub id: u64,
    pub owner: Pubkey,
    pub market: u8,
    pub sides: u8,
    pub k: u8,
    pub e_bps: u16,
    pub stake: u64,
    pub free_stake: u64,
    pub ruin_per_usd: u64,
    pub ruin_locked: u64,
}
#[event]
pub struct HouseFunded {
    pub house: Pubkey,
    pub quote_in: u64,
    pub ruin_in: u64,
    pub quote_out: u64,
    pub ruin_out: u64,
    pub stake: u64,
    pub ruin_locked: u64,
}
#[event]
pub struct HouseAccepting {
    pub house: Pubkey,
    pub accepting: bool,
}
#[event]
pub struct HouseClosed {
    pub house: Pubkey,
    pub owner: Pubkey,
    pub quote_returned: u64,
    pub ruin_returned: u64,
}
#[event]
pub struct OpenRequested {
    pub table: Pubkey,
    pub house: Pubkey,
    pub seq: u64,
    pub trader: Pubkey,
    pub owner: Pubkey,
    pub market: u8,
    pub side: Side,
    pub lev: u16,
    pub m: u64,
    pub k: u8,
    pub e_bps: u16,
    pub request_slot: u64,
    pub request_publish_ts: i64,
    pub request_price: u64,
}
#[event]
pub struct Opened {
    pub table: Pubkey,
    pub house: Pubkey,
    pub seq: u64,
    pub delay: u64,
    pub p0: u64,
    pub fill_slot: u64,
    pub fill_publish_ts: i64,
    pub fill_ts: i64,
}
#[event]
pub struct OpenRefunded {
    pub table: Pubkey,
    pub house: Pubkey,
    pub seq: u64,
    pub trader: Pubkey,
    pub m: u64,
    pub slot: u64,
}
#[event]
pub struct CloseRequested {
    pub table: Pubkey,
    pub house: Pubkey,
    pub seq: u64,
    pub close_request_slot: u64,
    pub close_publish_ts: i64,
    pub price: u64,
}
#[event]
pub struct Settled {
    pub table: Pubkey,
    pub house: Pubkey,
    pub seq: u64,
    pub trader: Pubkey,
    pub owner: Pubkey,
    pub market: u8,
    pub side: Side,
    pub lev: u16,
    pub m: u64,
    pub k: u8,
    pub e_bps: u16,
    pub p0: u64,
    pub fill_slot: u64,
    pub fill_publish_ts: i64,
    pub fill_ts: i64,
    pub end: End,
    pub p_end: u64,
    pub end_publish_ts: i64,
    pub end_slot: u64,
    pub end_ts: i64,
    pub f_e9: u64,
    pub a: u64,
    pub b: u64,
    pub stake_after: u64,
}
