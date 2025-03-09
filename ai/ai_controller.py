#!/usr/bin/env python3
import json
import random
from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/predict', methods=['GET'])
def predict():
    decision = random.choice(["trade", "wait"])
    return jsonify({
        "action": decision,
        "prediction": random.uniform(0, 1),
        "features": {
            "gasPrice": random.uniform(10, 100),
            "uniPool": random.uniform(1000, 5000),
            "sentiment": random.uniform(0, 1)
        }
    })

@app.route('/regime', methods=['GET'])
def regime():
    regime_indicator = random.choice([0, 1])
    return jsonify({"regime": regime_indicator})

@app.route('/parameters', methods=['GET'])
def parameters():
    return jsonify({
        "profitThreshold": random.randint(5000, 6000),
        "maxDailyLoss": random.randint(1000, 1200)
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
