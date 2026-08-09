#!/bin/sh

reward_dir=${HARBOR_REWARD_DIR:-/logs/verifier}
reward_file=${HARBOR_REWARD_FILE:-$reward_dir/reward.json}
grader_file=${HARBOR_TESTS_DIR:-/tests}/grader.mjs
fallback='{"functional":0,"regression":0,"tests_unchanged":0,"shippable":0}'

if ! mkdir -p "$reward_dir"; then
  exit 125
fi

if node "$grader_file"; then
  status=0
else
  status=$?
fi

# Keep the reward contract intact even if the grader process itself fails.
if [ ! -f "$reward_file" ]; then
  if ! printf '%s\n' "$fallback" > "$reward_file"; then
    exit 125
  fi
  if [ "$status" -eq 0 ]; then
    status=125
  fi
fi

exit "$status"
