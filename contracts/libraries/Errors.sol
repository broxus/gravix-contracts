pragma ever-solidity ^0.62.0;


library Errors {
    // ERRORS
    // COMMON
    uint16 constant NOT_OWNER = 1000;
    uint16 constant NOT_ACTIVE = 1001;
    uint16 constant NOT_EMERGENCY = 1002;
    uint16 constant WRONG_PUBKEY = 1003;
    uint16 constant LOW_MSG_VALUE = 1004;
    uint16 constant BAD_INPUT = 1005;
    uint16 constant NOT_TOKEN_WALLET = 1006;
    uint16 constant BAD_SENDER = 1007;
    uint16 constant EMERGENCY = 1008;
    uint16 constant NOT_TOKEN_ROOT = 1009;

    // VAULT
    uint16 constant NOT_VEX_ACCOUNT = 2000;
    uint16 constant ALREADY_INITIALIZED = 2001;

    uint16 constant MARKET_POSITIONS_LIMIT_REACHED = 2002;
    uint16 constant PLATFORM_POSITIONS_LIMIT_REACHED = 2003;

    // ACCOUNT
    uint16 constant NOT_VAULT = 3000;
}
