pragma ever-solidity ^0.62.0;



import "broxus-token-contracts/contracts/interfaces/ITokenRootUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/ITokenWalletUpgradeable.sol";
import "broxus-token-contracts/contracts/interfaces/IAcceptTokensTransferCallback.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../interfaces/IVexesAccount.sol";
import "./VexesVaultUpgradable.sol";
import {DateTime as DateTimeLib} from "../../libraries/DateTime.sol";



abstract contract VexesVaultLiquidityPool is VexesVaultUpgradable {
    // ----------------------------------------------------------------------------------
    // --------------------------- LIQUIDITY POOL ---------------------------------------
    // ----------------------------------------------------------------------------------
    function usdtToStvUsdt(uint128 usdt_amount) public view returns (uint128 stv_amount) {
        if (stvUsdtSupply == 0) return usdt_amount;
        return math.muldiv(usdt_amount, stvUsdtSupply, poolBalance);
    }

    function stvUsdtToUsdt(uint128 stv_amount) public view returns (uint128 usdt_amount) {
        if (stvUsdtSupply == 0) return stv_amount;
        return math.muldiv(stv_amount, poolBalance, stvUsdtSupply);
    }

    // @dev Prices are multiplied by 10**18
    // in price could be higher in case of under collateralization
    function stvUsdtPrice() public view returns (uint128 in_price, uint128 out_price) {
        if (stvUsdtSupply == 0) return (SCALING_FACTOR, SCALING_FACTOR);
        // out price is current real price
        out_price = math.muldiv(poolBalance, SCALING_FACTOR, stvUsdtSupply);
        // if we are in undercollateralized state
        in_price = targetPrice > 0 ? out_price + (targetPrice - out_price) / 2 : out_price;
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

    function _collectFeeWithSchema(uint32[2] fee_schema, uint128 amount) internal {
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
