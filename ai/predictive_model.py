import json
import os
import requests
import random
import numpy as np
import tensorflow as tf

def fetch_data():
    data = {}
    try:
        rGas = requests.get("https://api.etherscan.io/api?module=gastracker&action=gasoracle")
        data["gasPrice"] = float(rGas.json()["result"]["ProposeGasPrice"])
    except:
        data["gasPrice"] = random.uniform(10,300)
    data["uniPool"] = random.uniform(1000,5000)
    data["sentiment"] = random.uniform(0,1)
    return data

def load_model():
    path = os.getenv("LSTM_MODEL_PATH", "ai/ml-model/volatility_predictor.h5")
    return tf.keras.models.load_model(path)

def main():
    try:
        data = fetch_data()
        model = load_model()
        X = np.array([[data["gasPrice"], data["uniPool"], data["sentiment"]]], dtype=np.float32)
        pred = model.predict(X)[0][0]
        action = "trade" if pred > 0.7 else "wait"
        print(json.dumps({"action": action, "prediction": float(pred), "features": data}))
    except Exception as e:
        print(json.dumps({"action": "wait", "prediction": 0, "error": str(e)}))

if __name__ == "__main__":
    main()
