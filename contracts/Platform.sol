pragma ever-solidity ^0.62.0;

import "@broxus/contracts/contracts/platform/Platform.sol";


contract RPlatform is Platform {
    constructor(
        TvmCell code, TvmCell params, address sendGasTo
    ) public functionID(0x23dc4360) Platform(code, params, sendGasTo) {}
}
