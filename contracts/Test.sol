//pragma ever-solidity ^0.62.0;
//
//
//
//contract Test {
////    uint static nonce;
//    enum Action {one, two}
//
//    constructor() public {
//        tvm.accept();
//    }
//
//    function encode(uint8 kek) external pure returns (TvmCell) {
//        TvmBuilder builder;
//        builder.store(kek);
//        return builder.toCell();
//    }
//
//    function encode2(Action _action) external pure returns (TvmCell) {
//        TvmBuilder builder;
//        builder.store(_action);
//        return builder.toCell();
//    }
//
//    function testReserve(address send_gas_to) external view {
//        tvm.rawReserve(address(this).balance - msg.value, 0);
//
//        send_gas_to.transfer(0, false, 128);
//
//        uint sum = 0;
//        for (uint i = 0; i < 100; i++) {
//            sum += i;
//        }
//    }
//
//    function convert() external returns (uint8, uint8) {
//        return (uint8(Action.one), uint8(Action.two));
//    }
//
//    function decode(TvmCell payload) external pure returns (uint8) {
//        TvmSlice _slice = payload.toSlice();
//        return _slice.decode(uint8);
//    }
//
//    function decode2(TvmCell payload) external pure returns (Action) {
//        TvmSlice _slice = payload.toSlice();
//        return _slice.decode(Action);
//    }
//}
