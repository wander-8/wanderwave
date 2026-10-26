#!/usr/bin/env python3
import requests
import logging
from datetime import datetime

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')

EDGE_FUNCTION_URL = "https://wjhvifdbttlijxnreaha.supabase.co/functions/v1/musicjp-scrape-backfill"

try:
    response = requests.post(EDGE_FUNCTION_URL, timeout=300)
    result = response.json()
    logging.info(f"Service links sync: {result}")
except Exception as e:
    logging.error(f"Failed to sync service links: {e}")
