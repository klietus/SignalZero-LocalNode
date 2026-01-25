import pandas as pd
import redis
import json
import time
from datetime import datetime

# Configuration
PARQUET_FILE = '/Users/klietus/Downloads/test-00000-of-00001.parquet'
REDIS_HOST = 'localhost'
REDIS_PORT = 6380
TEST_SET_ID = 'GSM8k'
TEST_SET_NAME = 'GSM8k Benchmark'
TEST_SET_DESC = 'Grade School Math 8k Test Set'

def main():
    print(f"Reading {PARQUET_FILE}...")
    try:
        df = pd.read_parquet(PARQUET_FILE)
    except Exception as e:
        print(f"Error reading parquet: {e}")
        return

    print(f"Loaded {len(df)} rows.")
    
    # Check columns
    print(f"Columns: {df.columns.tolist()}")
    
    # Connect to Redis
    r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    try:
        r.ping()
        print("Connected to Redis.")
    except redis.ConnectionError:
        print("Failed to connect to Redis.")
        return

    # Prepare Test Set
    tests = []
    
    for index, row in df.iterrows():
        # Adjust column names if needed based on inspection
        question = row.get('question')
        answer = row.get('answer')
        
        if not question or not answer:
            continue
            
        test_case = {
            "id": f"{TEST_SET_ID}-T{index}",
            "name": f"GSM8k #{index + 1}",
            "prompt": question,
            "expectedActivations": [],
            "expectedResponse": answer
        }
        tests.append(test_case)

    # Construct Test Set Object
    test_set = {
        "id": TEST_SET_ID,
        "name": TEST_SET_NAME,
        "description": TEST_SET_DESC,
        "tests": tests,
        "createdAt": datetime.utcnow().isoformat() + "Z",
        "updatedAt": datetime.utcnow().isoformat() + "Z"
    }

    # Save to Redis
    # 1. Add to Set index
    r.sadd('sz:test_sets', TEST_SET_ID)
    
    # 2. Save payload
    r.set(f"sz:test_set:{TEST_SET_ID}", json.dumps(test_set))
    
    print(f"Successfully imported {len(tests)} tests into set '{TEST_SET_ID}'.")

if __name__ == "__main__":
    main()
