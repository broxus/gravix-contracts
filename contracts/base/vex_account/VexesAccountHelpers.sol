pragma ever-solidity ^0.62.0;


import "./VexesAccountStorage.sol";
import "@broxus/contracts/contracts/libraries/MsgFlag.sol";
import "../../libraries/Gas.sol";
import "../../libraries/Callback.sol";
import "../../libraries/PlatformTypes.sol";
import "../../libraries/Errors.sol";


abstract contract VexesAccountHelpers is VexesAccountStorage {
    function _reserve() internal pure returns (uint128) {
        return math.max(address(this).balance - msg.value, CONTRACT_MIN_BALANCE);
    }

    modifier onlyVexesVault() {
        require (msg.sender == vault, Errors.NOT_VAULT);
        _;
    }
}

