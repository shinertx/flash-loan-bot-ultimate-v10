def fetch_data():
    data = {}
    # Define a default gas price in case of failure.
    defaultGasPrice = 50.0  # Example default value in Gwei.
    try:
        rGas = requests.get("https://api.etherscan.io/api?module=gastracker&action=gasoracle", timeout=5)
        result = rGas.json().get("result", {})
        # Use the 'ProposeGasPrice' field, or default if missing.
        data["gasPrice"] = float(result.get("ProposeGasPrice", defaultGasPrice))
    except Exception as e:
        data["gasPrice"] = defaultGasPrice
    # Use heuristic-based defaults for other parameters.
    data["uniPool"] = random.uniform(1000, 5000)
    data["sentiment"] = random.uniform(0, 1)
    return data
