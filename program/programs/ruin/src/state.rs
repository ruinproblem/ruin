use crate::error::RuinError;
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub enum Side {
    Long,
    Short,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum HouseState {
    Idle,
    Busy,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum TableState {
    Requested,
    Open,
    CloseRequested,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub enum End {
    TraderLine,
    HouseLine,
    Stop,
    Expiry,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default)]
pub struct Market {
    pub feed: Pubkey,
    pub asset: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct Params {
    pub m_min: u64,
    pub free_stake: u64,
    pub ruin_per_usd: u64,
    pub delay_min: u16,
    pub delay_max: u16,
    pub fill_window: u16,
    pub close_window: u16,
    pub stale_secs: u32,
}
impl Params {
    pub fn validate(&self) -> Result<()> {
        let width = self
            .delay_max
            .checked_sub(self.delay_min)
            .ok_or(RuinError::InvalidValue)?;
        require!(
            self.m_min >= 1
                && self.delay_min >= 1
                && self.fill_window >= 1
                && self.close_window >= 1
                && width > self.fill_window
                && width > self.close_window
                && u32::from(self.delay_max) + u32::from(self.fill_window) <= 256
                && u32::from(self.delay_max) + u32::from(self.close_window) <= 256
                && (1..=600).contains(&self.stale_secs),
            RuinError::InvalidValue
        );
        Ok(())
    }
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct InitArgs {
    pub admin: Pubkey,
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
impl InitArgs {
    pub fn params(&self) -> Params {
        Params {
            m_min: self.m_min,
            free_stake: self.free_stake,
            ruin_per_usd: self.ruin_per_usd,
            delay_min: self.delay_min,
            delay_max: self.delay_max,
            fill_window: self.fill_window,
            close_window: self.close_window,
            stale_secs: self.stale_secs,
        }
    }
    pub fn validate(&self) -> Result<()> {
        self.params().validate()?;
        require!(
            self.lev_min >= 1
                && self.lev_min <= self.lev_max
                && self.lev_max <= 10_000
                && self.k_min >= 1
                && self.k_min <= self.k_max
                && self.k_max <= 100
                && self.e_min_bps <= self.e_max_bps
                && self.e_max_bps <= 10_000
                && self.expiry_secs >= 60,
            RuinError::InvalidValue
        );
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub quote_mint: Pubkey,
    pub ruin_mint: Option<Pubkey>,
    pub ruin_token_program: Option<Pubkey>,
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
    pub next_house_id: u64,
    pub bump: u8,
}
impl Config {
    pub fn apply(&mut self, p: Params) {
        self.m_min = p.m_min;
        self.free_stake = p.free_stake;
        self.ruin_per_usd = p.ruin_per_usd;
        self.delay_min = p.delay_min;
        self.delay_max = p.delay_max;
        self.fill_window = p.fill_window;
        self.close_window = p.close_window;
        self.stale_secs = p.stale_secs;
    }
}
#[account]
#[derive(InitSpace)]
pub struct House {
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
    pub accepting: bool,
    pub state: HouseState,
    pub next_seq: u64,
    pub current_seq: u64,
    pub bump: u8,
    pub vault_bump: u8,
    pub lock_vault_bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct Table {
    pub house: Pubkey,
    pub seq: u64,
    pub trader: Pubkey,
    pub market: u8,
    pub side: Side,
    pub lev: u16,
    pub m: u64,
    pub k: u8,
    pub e_bps: u16,
    pub delay_min: u16,
    pub delay_max: u16,
    pub fill_window: u16,
    pub close_window: u16,
    pub stale_secs: u32,
    pub expiry_secs: u32,
    pub state: TableState,
    pub request_slot: u64,
    pub request_publish_ts: i64,
    pub p0: u64,
    pub fill_slot: u64,
    pub fill_publish_ts: i64,
    pub fill_ts: i64,
    pub close_request_slot: u64,
    pub close_publish_ts: i64,
    pub bump: u8,
}

pub fn house_space(config: &Config, id: u64) -> Result<usize> {
    require_eq!(id, config.next_house_id, RuinError::IdMismatch);
    Ok(8 + House::INIT_SPACE)
}
