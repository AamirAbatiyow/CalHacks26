#!/usr/bin/env python3
"""
Fetch labeled SatNOGS observations with incremental saving and proper backoff.

This script fetches good/bad/failed observations separately to maximize
the number of labeled passes for ML training.
"""

import requests
import time
import json
import sys
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict

SATNOGS_API = "https://network.satnogs.org/api"
OUTPUT_DIR = Path(__file__).parent.parent / "data" / "raw"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

OUTPUT_FILE = OUTPUT_DIR / "satnogs_observations_labeled.json"
PROGRESS_FILE = OUTPUT_DIR / "fetch_progress.json"


def save_progress(observations, status_counts):
    """Save current progress to disk."""
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(observations, f)
    
    with open(PROGRESS_FILE, 'w') as f:
        json.dump({
            "count": len(observations),
            "status_counts": dict(status_counts),
            "updated_at": datetime.now().isoformat(),
        }, f, indent=2)


def fetch_observations_by_status(status, limit=2000, days_back=365, existing_ids=None):
    """
    Fetch observations filtered by status with incremental saving.
    """
    observations = []
    seen_ids = existing_ids or set()
    
    end_date = datetime.now()
    start_date = end_date - timedelta(days=days_back)
    
    params = {
        "start": start_date.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end": end_date.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": status,
        "format": "json",
    }
    
    url = f"{SATNOGS_API}/observations/"
    page = 0
    consecutive_429s = 0
    max_consecutive_429s = 3
    
    print(f"\nFetching '{status}' observations (target: {limit})...")
    
    while len(observations) < limit and url and page < 200:
        try:
            # Conservative rate limiting: ~40 req/min
            time.sleep(1.5)
            
            response = requests.get(
                url, 
                params=params if page == 0 else None,
                timeout=60
            )
            
            if response.status_code == 429:
                consecutive_429s += 1
                retry_after = min(int(response.headers.get("Retry-After", 60)), 180)
                print(f"  Rate limited ({consecutive_429s}/{max_consecutive_429s}). Waiting {retry_after}s...")
                
                if consecutive_429s >= max_consecutive_429s:
                    print(f"  Too many rate limits. Stopping at {len(observations)} observations.")
                    break
                
                time.sleep(retry_after)
                continue
            
            response.raise_for_status()
            consecutive_429s = 0  # Reset on success
            
            data = response.json()
            if not data:
                print(f"  No more data after page {page}")
                break
            
            new_count = 0
            for obs in data:
                obs_id = obs.get("id")
                if obs_id and obs_id not in seen_ids:
                    observations.append(obs)
                    seen_ids.add(obs_id)
                    new_count += 1
            
            page += 1
            
            if page % 10 == 0:
                print(f"  Page {page}: {len(observations)} '{status}' observations (+{new_count})")
            
            # Get next page from Link header
            link_header = response.headers.get("Link", "")
            url = None
            for part in link_header.split(","):
                if 'rel="next"' in part:
                    url_match = part.split(";")[0].strip()
                    if url_match.startswith("<") and url_match.endswith(">"):
                        url = url_match[1:-1]
                        break
            
            if not url:
                print(f"  No more pages. Got {len(observations)} '{status}' observations.")
                break
            
            if new_count == 0:
                print(f"  No new observations on page {page}. Stopping.")
                break
                
        except requests.exceptions.Timeout:
            print(f"  Timeout on page {page}. Retrying...")
            time.sleep(30)
            
        except requests.RequestException as e:
            print(f"  Error: {e}")
            time.sleep(30)
            page += 1
    
    return observations, seen_ids


def main():
    print("=" * 60)
    print("SatNOGS Labeled Observations Fetcher")
    print("=" * 60)
    
    all_observations = []
    all_ids = set()
    status_counts = defaultdict(int)
    
    # Load existing progress if available
    if OUTPUT_FILE.exists():
        try:
            existing = json.load(open(OUTPUT_FILE))
            all_observations = existing
            all_ids = {obs.get("id") for obs in existing}
            for obs in existing:
                status_counts[obs.get("status", "unknown")] += 1
            print(f"\nResuming from {len(all_observations)} existing observations")
        except:
            pass
    
    # Fetch each status type
    targets = [
        ("good", 2000),
        ("bad", 1000),
        ("failed", 500),
    ]
    
    for status, limit in targets:
        current_count = status_counts.get(status, 0)
        if current_count >= limit:
            print(f"\nAlready have {current_count} '{status}' observations (target: {limit})")
            continue
        
        remaining = limit - current_count
        obs, all_ids = fetch_observations_by_status(
            status, 
            limit=remaining,
            days_back=365,
            existing_ids=all_ids
        )
        
        all_observations.extend(obs)
        for o in obs:
            status_counts[o.get("status", "unknown")] += 1
        
        # Save progress after each status type
        save_progress(all_observations, status_counts)
        print(f"  -> Saved {len(all_observations)} total observations")
    
    # Final summary
    print("\n" + "=" * 60)
    print("FETCH COMPLETE")
    print("=" * 60)
    print(f"Total observations: {len(all_observations)}")
    print(f"Status distribution: {dict(status_counts)}")
    
    labeled = sum(status_counts.get(s, 0) for s in ["good", "bad", "failed"])
    print(f"Total LABELED passes: {labeled}")
    print(f"Saved to: {OUTPUT_FILE}")
    
    return labeled


if __name__ == "__main__":
    labeled_count = main()
    sys.exit(0 if labeled_count >= 1000 else 1)
