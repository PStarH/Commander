import os
import json
import requests
from datetime import datetime

# Define workspace directory
workspace_dir = "/Users/sampan/Documents/GitHub/Commander/benchmarks/pinchbench/results_direct/run_1/task_workflow"

# Define file paths
config_path = os.path.join(workspace_dir, "config.json")
script_path = os.path.join(workspace_dir, "api_caller.py")
notes_path = os.path.join(workspace_dir, "NOTES.md")

# Check if config.json exists
if os.path.exists(config_path):
    print(f"Found existing config.json at {config_path}")
    with open(config_path, 'r') as f:
        config_data = json.load(f)
else:
    print(f"config.json not found. Creating sample config.json at {config_path}")
    # Create a sample config.json with a realistic API endpoint
    config_data = {
        "api_endpoint": "https://jsonplaceholder.typicode.com/posts",
        "api_key": "sample_api_key_12345",
        "timeout": 30,
        "headers": {
            "Content-Type": "application/json",
            "Authorization": "Bearer sample_token"
        }
    }
    with open(config_path, 'w') as f:
        json.dump(config_data, f, indent=2)

# Extract API endpoint from config
api_endpoint = config_data.get("api_endpoint")
if not api_endpoint:
    raise ValueError("No 'api_endpoint' found in config.json")

print(f"Extracted API endpoint: {api_endpoint}")

# Create Python script to call the API
script_content = '''#!/usr/bin/env python3
"""
API Caller Script
Generated on: {timestamp}
API Endpoint: {endpoint}
"""

import requests
import json
import sys
from datetime import datetime

def call_api():
    """Call the API endpoint with configuration from config.json"""
    
    # Load configuration
    config_path = "{config_path}"
    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
    except FileNotFoundError:
        print(f"Error: Config file not found at {{config_path}}")
        return False
    except json.JSONDecodeError:
        print(f"Error: Invalid JSON in config file at {{config_path}}")
        return False
    
    # Extract configuration
    api_endpoint = config.get("api_endpoint")
    api_key = config.get("api_key")
    timeout = config.get("timeout", 30)
    headers = config.get("headers", {{}})
    
    if not api_endpoint:
        print("Error: No 'api_endpoint' found in config")
        return False
    
    # Add API key to headers if provided
    if api_key:
        headers["Authorization"] = f"Bearer {{api_key}}"
    
    print(f"Calling API endpoint: {{api_endpoint}}")
    print(f"Timestamp: {{datetime.now().isoformat()}}")
    
    try:
        # Make GET request
        response = requests.get(
            api_endpoint,
            headers=headers,
            timeout=timeout
        )
        
        # Check response status
        response.raise_for_status()
        
        print(f"API call successful!")
        print(f"Status Code: {{response.status_code}}")
        print(f"Response Headers: {{dict(response.headers)}}")
        
        # Try to parse JSON response
        try:
            json_response = response.json()
            print(f"Response JSON (first 500 chars): {{str(json_response)[:500]}}...")
        except json.JSONDecodeError:
            print(f"Response Text (first 500 chars): {{response.text[:500]}}...")
        
        return True
        
    except requests.exceptions.RequestException as e:
        print(f"API call failed: {{e}}")
        return False
    except Exception as e:
        print(f"Unexpected error: {{e}}")
        return False

if __name__ == "__main__":
    success = call_api()
    sys.exit(0 if success else 1)
'''.format(
    timestamp=datetime.now().isoformat(),
    endpoint=api_endpoint,
    config_path=config_path
)

# Write the Python script
with open(script_path, 'w') as f:
    f.write(script_content)

print(f"Created API caller script at {script_path}")

# Create NOTES.md documentation
notes_content = '''# API Caller Documentation

## Overview
This document describes the process of reading configuration, extracting API endpoint, and creating a Python script to call the API.

## Files Created
1. **config.json** - Configuration file containing API endpoint and settings
2. **api_caller.py** - Python script to call the configured API endpoint
3. **NOTES.md** - This documentation file

## Configuration Details
- **API Endpoint**: {endpoint}
- **Configuration File**: {config_path}
- **Script Created**: {script_path}

## Process Description

### Step 1: Read Configuration
The script first checks if `config.json` exists in the workspace directory. If it exists, it reads the configuration; if not, it creates a sample configuration file with realistic API settings.

### Step 2: Extract API Endpoint
From the configuration, the script extracts the `api_endpoint` field. This is the URL that will be called by the API caller script.

### Step 3: Create API Caller Script
A Python script (`api_caller.py`) is created that:
- Reads the configuration from `config.json`
- Makes HTTP requests to the configured API endpoint
- Handles authentication via API key or Bearer token
- Includes error handling for network issues and invalid responses
- Logs the response status and content

### Step 4: Documentation
This `NOTES.md` file documents the entire process, including file locations, configuration details, and usage instructions.

## Usage Instructions

### Running the API Caller
