import json
import os
import requests
import random
import numpy as np
import tensorflow as tf

def fetch_data():
    data = {}
    defaultGasPrice = 50.0
    try:
        etherscan_api = os.getenv("ETHERSCAN_API_KEY", "")
        url = f"https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey={etherscan_api}"
        rGas = requests.get(url, timeout=5)
        result = rGas.json().get("result", {})
        data["gasPrice"] = float(result.get("ProposeGasPrice", defaultGasPrice))
    except Exception:
        data["gasPrice"] = defaultGasPrice

    # Additional "marketVol" from a random logic to mimic advanced feature
    data["marketVol"] = random.uniform(0.0, 1.0)
    data["sentiment"] = random.uniform(-1, 1)
    return data

def load_model():
    path = os.getenv("LSTM_MODEL_PATH", "ai/ml-model/volatility_predictor.h5")
    if not os.path.exists(path):
        return None  # no real model
    return tf.keras.models.load_model(path)

def main():
    try:
        data = fetch_data()
        model = load_model()
        if model:
            X = np.array([[data["gasPrice"], data["marketVol"], data["sentiment"]]], dtype=np.float32)
            pred = model.predict(X)[0][0]
            action = "trade" if pred > 0.6 else "wait"
            print(json.dumps({"action": action, "prediction": float(pred), "features": data}))
        else:
            # Fallback logic if no real model
            score = (data["marketVol"] + (1 - abs(data["sentiment"])))/2
            action = "trade" if score > 0.5 else "wait"
            print(json.dumps({"action": action, "prediction": float(score), "features": data}))
    except Exception as e:
        print(json.dumps({"action": "wait", "prediction": 0, "error": str(e)}))

if __name__ == "__main__":
    main()
