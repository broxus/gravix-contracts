import { toNano } from "../../../ever-locklift";

export enum PosType {
    Long = 0,
    Short = 1,
}
export enum LimitType {
    Limit = 0,
    Stop = 1,
}
export enum StopPositionType {
    StopLoss = 0,
    TakeProfit = 1,
}
export enum LimitOrderSate {
    Pending = "0",
    Executed = "1",
}

export const OPEN_ORDER_FEE = toNano(0.1);
export const ORACLE_PROXY_DEPLOY = toNano(0.22);
export const ORACLE_PROXY_CALL = toNano(0.1);
export const FEE_FOR_TOKEN_TRANSFER = toNano(0.04);
export const BOUNCE_HANDLING_FEE = toNano(0.1);
export const GRAVIX_ACCOUNT_DEPLOY_VALUE = toNano(0.65);
export const RETRIEVE_REFERRER_VALUE = toNano(0.15);
export const EDIT_COLLATERAL_FEES = toNano(0.25);
export const EXECUTE_STOP_ORDER_VALUE = toNano(0.5);
