use crate::error::RuinError;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        default_account_state::DefaultAccountState, transfer_hook::TransferHook,
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    state::{AccountState, Mint},
};

pub fn validate_mint(account: &AccountInfo<'_>) -> Result<()> {
    if *account.owner == anchor_spl::token::ID {
        return Ok(());
    }
    require_keys_eq!(
        *account.owner,
        anchor_spl::token_2022::ID,
        RuinError::UnsupportedTokenProgram
    );
    let data = account.try_borrow_data()?;
    let mint = StateWithExtensions::<Mint>::unpack(&data)?;
    let extensions = mint.get_extension_types()?;
    require!(
        !extensions.contains(&ExtensionType::TransferFeeConfig),
        RuinError::TransferFeeMint
    );
    if extensions.contains(&ExtensionType::TransferHook) {
        let hook = mint.get_extension::<TransferHook>()?;
        require!(
            Option::<Pubkey>::from(hook.program_id).is_none(),
            RuinError::TransferHookActive
        );
    }
    if extensions.contains(&ExtensionType::DefaultAccountState) {
        require!(
            mint.get_extension::<DefaultAccountState>()?.state == AccountState::Initialized as u8,
            RuinError::DefaultStateFrozen
        );
    }
    Ok(())
}
