import json
import os
import requests
import numpy as np
import pandas as pd
from datetime import datetime, timedelta, timezone
# import tensorflow as tf  # Uncomment when you have a real model (and install tensorflow)

# --- Configuration (Load from environment variables) ---
ETHERSCAN_API_KEY = os.getenv("ETHERSCAN_API_KEY")
# Add other API keys as needed (e.g., for centralized exchange data)
UNISWAP_V2_GRAPH_ENDPOINT = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2"  # Example, Mainnet
# Add other GraphQL endpoints for other DEXes (SushiSwap, etc.) and networks!

# --- Data Fetching Functions ---

def fetch_gas_price():
    try:
        url = f"https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey={ETHERSCAN_API_KEY}"
        response = requests.get(url, timeout=10)
        response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
        result = response.json().get("result", {})
        return float(result.get("ProposeGasPrice", 50.0))  # Default to 50 Gwei
    except requests.exceptions.RequestException as e:
        print(f"Error fetching gas price: {e}")
        return 50.0  # Default value on error


def fetch_uniswap_v2_data(pair_address, hours=24):
    #  Fetch historical data for a Uniswap V2 pair from The Graph.
    #  This is a simplified example.  For real use, you'd want:
    #  - Pagination (handle more than 1000 results)
    #  - Error handling (retry on failures)
    #  - More sophisticated data aggregation (e.g., OHLCV candles)
    #  - Data from multiple DEXes

    now = datetime.now(timezone.utc)
    start_time = int((now - timedelta(hours=hours)).timestamp())

    query = """
    {
      pairHourDatas(
        first: 1000
        where: {pair: "%s", hourStartUnix_gte: %s}
        orderBy: hourStartUnix
        orderDirection: asc
      ) {
        hourStartUnix
        reserve0
        reserve1
        reserveUSD
        hourlyVolumeToken0
        hourlyVolumeToken1
        hourlyVolumeUSD
      }
    }
    """ % (pair_address.lower(), start_time)

    try:
        response = requests.post(UNISWAP_V2_GRAPH_ENDPOINT, json={'query': query})
        response.raise_for_status()
        data = response.json()
        return data['data']['pairHourDatas']
    except requests.exceptions.RequestException as e:
        print(f"Error fetching Uniswap V2 data: {e}")
        return []

# --- Feature Engineering ---

def create_features(gas_price, uniswap_data):
    #  This is a *placeholder* for feature engineering.  You'll need to
    #  develop features that are relevant to your trading strategy.

    if not uniswap_data:
        return {
            "gas_price": gas_price,
            "volatility": 0.0,  # Placeholder
            "volume": 0.0,      # Placeholder
            "price_change": 0.0, # Placeholder
        }

    df = pd.DataFrame(uniswap_data)
    df['reserve0'] = pd.to_numeric(df['reserve0'])
    df['reserve1'] = pd.to_numeric(df['reserve1'])
    df['hourlyVolumeUSD'] = pd.to_numeric(df['hourlyVolumeUSD'])

    # Calculate volatility (example: standard deviation of price)
    #  Need to derive price from reserves.  Assuming reserve0 is DAI, reserve1 is WETH
    df['price'] = df['reserve0'] / df['reserve1']
    volatility = df['price'].std()

    # Calculate total volume
    volume = df['hourlyVolumeUSD'].sum()

    #Calculate Price Change
    price_change = (df['price'].iloc[-1] - df['price'].iloc[0]) / df['price'].iloc[0] if len(df) > 0 else 0


    return {
        "gas_price": gas_price,
        "volatility": volatility if not np.isnan(volatility) else 0.0,  # Handle potential NaN
        "volume": volume,
        "price_change": price_change
    }


# --- Model (Placeholder) ---
#  Replace this with your trained TensorFlow/Keras/PyTorch model.

# def load_model():
#     path = os.getenv("LSTM_MODEL_PATH", "ai/ml-model/volatility_predictor.h5")
#     if not os.path.exists(path):
#         return None
#     return tf.keras.models.load_model(path)


# def predict_with_model(model, features):
#    # Preprocess features as needed for your model
#    X = np.array([[features["gas_price"], features["volatility"], features["volume"]]], dtype=np.float32)
#    # Reshape for LSTM if needed
#    prediction = model.predict(X)[0][0]  # Get the prediction
#   return prediction

# --- Main Function ---
def predict_action(dai_weth_address):
    gas_price = fetch_gas_price()
    uniswap_data = fetch_uniswap_v2_data(dai_weth_address) #Pass in pair.
    features = create_features(gas_price, uniswap_data)

    # model = load_model() #Uncomment when you have a trained model.
    model = None
    if model:
       # prediction = predict_with_model(model, features)
       # action = "trade" if prediction > 0.6 else "wait" # Example threshold
       pass #remove when model is loaded
    else:
        # Fallback heuristic (replace with your model!)
        # Higher volatility, lower gas price = better for arbitrage
        score = (features["volatility"] * 100) + (1 - (features["gas_price"] / 100))
        if features["price_change"] > 0:
            score = score * (1.0 + features["price_change"]) #simple momentum
        action = "trade" if score > 0.6 else "wait"  # Example threshold
        prediction = score #This isn't used with no model.

    return {
        "action": action,
        "prediction": float(0), #Replace prediction
        "features": features,
        "recommended_slippageBP": int(max(50, features["volatility"] * 500)),  # Example slippage based on vol
        "bridging": False if features["volatility"] < 0.05 else True,  # Example bridging logic
    }


if __name__ == "__main__":
    # This is just for *local testing* of the Python file.
    # The Flask app (ai_controller.py) is the real entry point.
    action_data = predict_action("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") # Example:  DAI/USDC pair
    print(json.dumps(action_data, indent=2))
    #you will need to pip install pandas
    # you will need to add ETHERSCAN_API_KEY to the .env file
