pragma ever-solidity ^0.62.0;


import "broxus-token-contracts/contracts/interfaces/IBurnableTokenWallet.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../interfaces/IVexesAccount.sol";
import "./VexesVaultUpgradable.sol";


abstract contract VexesVaultLiquidityPool is VexesVaultUpgradable {
    // ----------------------------------------------------------------------------------
    // --------------------------- LIQUIDITY POOL ---------------------------------------
    // ----------------------------------------------------------------------------------
    function _handleUsdtDeposit(
        address user, uint128 amount, Callback.CallMeta meta
    ) internal {
        uint128 mint_amount = usdtToStvUsdt(amount);

        poolBalance += amount;
        stvUsdtSupply += mint_amount;

        emit LiquidityPoolDeposit(meta.call_id, user, amount, mint_amount);

        ITokenRoot(stvUsdt).mint{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            mint_amount, user, Gas.TOKEN_WALLET_DEPLOY_VALUE / 2, meta.send_gas_to, true, _makeCell(meta.nonce)
        );
    }

    function _handleStvUsdtDeposit(address user, uint128 amount, Callback.CallMeta meta) internal view {
        TvmBuilder builder;
        builder.store(user);
        builder.store(meta);
        IBurnableTokenWallet(stvUsdtWallet).burn{value: 0, flag: MsgFlag.ALL_NOT_RESERVED}(
            amount, meta.send_gas_to, address(this), builder.toCell()
        );
    }

    function _handleStvUsdtBurn(uint128 stv_usdt_amount, TvmCell payload) internal {
        TvmSlice slice = payload.toSlice();

        address user = slice.decode(address);
        Callback.CallMeta meta = slice.decode(Callback.CallMeta);

        uint128 usdt_amount = stvUsdtToUsdt(stv_usdt_amount);

        poolBalance -= usdt_amount;
        stvUsdtSupply -= stv_usdt_amount;

        emit LiquidityPoolWithdraw(meta.call_id, user, usdt_amount, stv_usdt_amount);

        _transfer(usdtWallet, usdt_amount, user, _makeCell(meta.nonce), meta.send_gas_to, MsgFlag.ALL_NOT_RESERVED);
    }

    function usdtToStvUsdt(uint128 usdt_amount) public view returns (uint128 stv_amount) {
        if (stvUsdtSupply == 0) return usdt_amount;
        (uint128 in_price,) = stvUsdtPrice();
        return math.muldiv(usdt_amount, SCALING_FACTOR, in_price);
    }

    function stvUsdtToUsdt(uint128 stv_amount) public view returns (uint128 usdt_amount) {
        if (stvUsdtSupply == 0) return stv_amount;
        (,uint128 out_price) = stvUsdtPrice();
        return math.muldiv(stv_amount, out_price, SCALING_FACTOR);
    }

    // @dev Prices are multiplied by 10**18
    // in price could be higher in case of under collateralization
    function stvUsdtPrice() public view returns (uint128 in_price, uint128 out_price) {
        if (stvUsdtSupply == 0) return (SCALING_FACTOR, SCALING_FACTOR);
        // out price is current real price
        out_price = math.muldiv(poolBalance, SCALING_FACTOR, stvUsdtSupply);
        // if we are in undercollateralized state
        in_price = targetPrice > 0 ? targetPrice : out_price;
    }

    function poolDebt() public view returns (uint128) {
        uint128 target_balance = math.muldiv(stvUsdtSupply, targetPrice, SCALING_FACTOR);
        return poolBalance >= target_balance ? 0 : target_balance - poolBalance;
    }
    // ----------------------------------------------------------------------------------
    // --------------------------- MONEY FLOW MUTATORS ----------------------------------
    // ----------------------------------------------------------------------------------
    function _collectOpenFee(uint128 amount) internal {
        _collectFeeWithSchema(openFeeDistributionSchema, amount);
    }

    function _collectCloseFee(uint128 amount) internal {
        _collectFeeWithSchema(closeFeeDistributionSchema, amount);
    }

    function _collectFeeWithSchema(uint64[2] fee_schema, uint128 amount) internal {
        uint128 pool_fee = math.muldiv(amount, fee_schema[uint256(DistributionSchema.Pool)], HUNDRED_PERCENT);
        uint128 fund_fee = amount - pool_fee;

        if (fund_fee > 0) _increaseInsuranceFund(fund_fee);
        if (pool_fee > 0) {
            poolBalance += pool_fee;
            // we are in undercollaterized state and recover is finished
            if (targetPrice > 0 && poolDebt() == 0) targetPrice = 0;
        }

    }

    function _decreaseInsuranceFund(uint128 amount) internal {
        if (amount <= insuranceFund) {
            insuranceFund -= amount;
        } else {
            uint128 delta = amount - insuranceFund;
            // we just ran out of insurance fund, save target price
            if (targetPrice == 0) {
                (targetPrice,) = stvUsdtPrice();
            }
            poolBalance -= delta;
            insuranceFund = 0;
        }
    }

    function _increaseInsuranceFund(uint128 amount) internal {
        if (targetPrice > 0) {
            uint128 debt = poolDebt();
            poolBalance += math.min(debt, amount);
            amount -= math.min(debt, amount);
            if (amount > 0) targetPrice = 0;
        }
        insuranceFund += amount;
    }
}
