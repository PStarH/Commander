#!/usr/bin/env python3
import json
import urllib.request

with open("config.json") as f:
    config = json.load(f)

url = config["api_endpoint"]
timeout = config.get("timeout", 30)

try:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        print(response.read().decode())
except Exception as e:
    print(f"Error: {e}")
