#!/bin/bash
# Kill orphaned test processes
# Use this to clean up background test processes that were forgotten

echo "Checking for test processes..."

# Find all vitest/node test processes
TEST_PIDS=$(ps aux | grep -E "(vitest|jest|node.*test|node.*vitest)" | grep -v grep | awk '{print $2}')

if [ -z "$TEST_PIDS" ]; then
  echo "No test processes found."
  exit 0
fi

echo "Found test processes:"
ps aux | grep -E "(vitest|jest|node.*test|node.*vitest)" | grep -v grep

echo ""
read -p "Kill these processes? (y/N) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "Killing test processes..."
  echo "$TEST_PIDS" | xargs kill -9 2>/dev/null
  echo "Done."
else
  echo "Cancelled."
fi

