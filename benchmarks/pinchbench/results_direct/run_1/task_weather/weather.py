#!/usr/bin/env python3
"""Fetch weather data for San Francisco using wttr.in API."""

import urllib.request
import json

def get_weather():
    """Fetch and display weather for San Francisco."""
    url = "https://wttr.in/San_Francisco?format=j1"
    
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode())
            
        current = data["current_condition"][0]
        temp_f = current["temp_F"]
        temp_c = current["temp_C"]
        humidity = current["humidity"]
        description = current["weatherDesc"][0]["value"]
        
        print(f"San Francisco Weather:")
        print(f"  Temperature: {temp_f}°F ({temp_c}°C)")
        print(f"  Humidity: {humidity}%")
        print(f"  Conditions: {description}")
        
    except Exception as e:
        print(f"Error fetching weather: {e}")

if __name__ == "__main__":
    get_weather()
