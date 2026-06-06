#!/usr/bin/env python3
"""Fetch and display weather data for San Francisco from wttr.in."""

import urllib.request
import json
import sys


def fetch_weather(city="San Francisco"):
    """Fetch weather data from wttr.in API."""
    url = f"https://wttr.in/{city.replace(' ', '+')}?format=j1"
    req = urllib.request.Request(url, headers={"User-Agent": "curl/7.68.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"Error fetching weather data: {e}", file=sys.stderr)
        sys.exit(1)


def print_summary(data):
    """Print a human-readable weather summary."""
    current = data["current_condition"][0]
    area = data["nearest_area"][0]
    city = area["areaName"][0]["value"]
    region = area["region"][0]["value"]
    country = area["country"][0]["value"]

    temp_f = current["temp_F"]
    temp_c = current["temp_C"]
    feels_f = current["FeelsLikeF"]
    feels_c = current["FeelsLikeC"]
    humidity = current["humidity"]
    wind_mph = current["windspeedMiles"]
    wind_dir = current["winddir16Point"]
    desc = current["weatherDesc"][0]["value"]
    visibility = current["visibility"]
    uv_index = current["uvIndex"]
    precip_mm = current["precipMM"]
    pressure = current["pressure"]
    cloud_cover = current["cloudcover"]

    print(f"=== Weather for {city}, {region}, {country} ===")
    print(f"Conditions:   {desc}")
    print(f"Temperature:  {temp_f}°F ({temp_c}°C)")
    print(f"Feels like:   {feels_f}°F ({feels_c}°C)")
    print(f"Humidity:     {humidity}%")
    print(f"Wind:         {wind_mph} mph {wind_dir}")
    print(f"Visibility:   {visibility} mi")
    print(f"UV Index:     {uv_index}")
    print(f"Precipitation:{precip_mm} mm")
    print(f"Pressure:     {pressure} mb")
    print(f"Cloud Cover:  {cloud_cover}%")
    print()

    # 3-day forecast
    print("=== 3-Day Forecast ===")
    for day in data.get("weather", []):
        date = day["date"]
        max_f = day["maxtempF"]
        min_f = day["mintempF"]
        max_c = day["maxtempC"]
        min_c = day["mintempC"]
        desc_day = day["hourly"][4]["weatherDesc"][0]["value"]  # midday
        print(f"{date}:  {min_f}–{max_f}°F ({min_c}–{max_c}°C), {desc_day}")


if __name__ == "__main__":
    weather_data = fetch_weather()
    print_summary(weather_data)
