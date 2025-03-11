#!/usr/bin/env python3
import json
import random
from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/predict', methods=['GET'])
def predict():
    # Example advanced random logic
    vol = random.uniform(0, 1)
    sentiment = random.uniform(-1, 1)
    combined_score = (vol + (1 - abs(sentiment))) / 2
    action = "trade" if combined_score > 0.5 else "wait"
    return jsonify({
        "action": action,
        "prediction": combined_score,
        "features": {
            "vol": vol,
            "sentiment": sentiment
        }
    })

@app.route('/regime', methods=['GET'])
def regime():
    # 0 = normal, 1 = volatile
    regime_indicator = 1 if random.random() > 0.7 else 0
    return jsonify({"regime": regime_indicator})

@app.route('/parameters', methods=['GET'])
def parameters():
    # Dynamically adjust thresholds
    return jsonify({
        "profitThreshold": random.randint(200, 1000),
        "maxDailyLoss": random.randint(500, 1500)
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
