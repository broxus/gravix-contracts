import csv
import json

def percent_to_sol(num: str):
    return int((float(num.replace('%', '')) / 100) * 10**12)

schedule = {
    'Forex': [
        [1, [{'from': {'hour': 0, 'minute': 0}, 'to': {'hour': 0, 'minute': 0}}]],
        [2, [{'from': {'hour': 0, 'minute': 0}, 'to': {'hour': 0, 'minute': 0}}]],
        [3, [{'from': {'hour': 0, 'minute': 0}, 'to': {'hour': 0, 'minute': 0}}]],
        [4, [{'from': {'hour': 0, 'minute': 0}, 'to': {'hour': 0, 'minute': 0}}]],
        [5, [{'from': {'hour': 0, 'minute': 0}, 'to': {'hour': 20, 'minute': 0}}]],
        [7, [{'from': {'hour': 21, 'minute': 0}, 'to': {'hour': 0, 'minute': 0}}]],
    ],
    'Equities': [
        [1, [{'from': {'hour': 13, 'minute': 30}, 'to': {'hour': 20, 'minute': 0}}]],
        [2, [{'from': {'hour': 13, 'minute': 30}, 'to': {'hour': 20, 'minute': 0}}]],
        [3, [{'from': {'hour': 13, 'minute': 30}, 'to': {'hour': 20, 'minute': 0}}]],
        [4, [{'from': {'hour': 13, 'minute': 30}, 'to': {'hour': 20, 'minute': 0}}]],
        [5, [{'from': {'hour': 13, 'minute': 30}, 'to': {'hour': 20, 'minute': 0}}]]
    ],
    'Commodities': [
        [1, [{'from': {'hour': 0, 'minute': 0}, 'to': {'hour': 21, 'minute': 0}}, {'from': {'hour': 22, 'minute': 0}, 'to': {'hour': 0, 'minute': 0}}]],
        [2, [{'from': {'hour': 0, 'minute': 0}, 'to': {'hour': 21, 'minute': 0}}, {'from': {'hour': 22, 'minute': 0}, 'to': {'hour': 0, 'minute': 0}}]],
        [3, [{'from': {'hour': 0, 'minute': 0}, 'to': {'hour': 21, 'minute': 0}}, {'from': {'hour': 22, 'minute': 0}, 'to': {'hour': 0, 'minute': 0}}]],
        [4, [{'from': {'hour': 0, 'minute': 0}, 'to': {'hour': 21, 'minute': 0}}, {'from': {'hour': 22, 'minute': 0}, 'to': {'hour': 0, 'minute': 0}}]],
        [5, [{'from': {'hour': 0, 'minute': 0}, 'to': {'hour': 21, 'minute': 0}}]],
        [7, [{'from': {'hour': 22, 'minute': 0}, 'to': {'hour': 0, 'minute': 0}}]]
    ]
}

setup = []
oracle_setup = []
price_node_setup = []
BASE_DECIMALS = 10**6
with open('gravix_setup.csv', 'r') as f:
    reader = csv.reader(f, delimiter=',')
    tmp = next(reader)
    print ('Skipping', tmp)
    for row in reader:
        _type, idx, chain_id, ticker, open_fee, close_fee, borrow_fee, funding_fee, depth, spread, dyn_spread, max_lev, ttl = row
        conf = {
            "priceSource": 1,
            "maxLongsUSD": 100_000_000_000, # 100k
            "maxShortsUSD": 100_000_000_000, # 100k
            "maxLeverage": int(float(max_lev) * 1000000),
            "depthAsset": int(float(depth.replace(',', '')) * BASE_DECIMALS),
            "fees": {
                "openFeeRate": percent_to_sol(open_fee),
                "closeFeeRate": percent_to_sol(close_fee),
                "baseSpreadRate": percent_to_sol(spread),
                "baseDynamicSpreadRate": percent_to_sol(dyn_spread),
                "borrowBaseRatePerHour": percent_to_sol(borrow_fee),
                "fundingBaseRatePerHour": percent_to_sol(funding_fee)
            },
            "scheduleEnabled": True if _type in schedule else False,
            "workingHours": schedule.get(_type, [])
        }
        ttl2 = int(float(ttl.replace(',', '')))
        oracle_conf = {
            "dex": {"targetToken": "0:0000000000000000000000000000000000000000000000000000000000000000", "path": []},
            "priceNode": {
                "ticker": ticker,
                "maxOracleDelay": ttl2,
                "maxServerDelay": 15,
            }
        }
        node_conf = {
            "ticker": ticker,
            "maxOracleDelay": ttl2,
            "maxServerDelay": 25,
            "enabled": True
        }

        setup.append(conf)
        oracle_setup.append(oracle_conf)
        price_node_setup.append(node_conf)

with open('setup.json', 'w') as f:
    json.dump(setup, f)


with open('oracle_setup.json', 'w') as f:
    json.dump(oracle_setup, f)


with open('price_node_configs.json', 'w') as f:
    json.dump(price_node_setup, f)

# print (json.dumps(setup, sort_keys=True, indent=4))
# print (json.dumps(oracle_setup, sort_keys=True, indent=4))
# print (json.dumps(price_node_setup, sort_keys=True, indent=4))
