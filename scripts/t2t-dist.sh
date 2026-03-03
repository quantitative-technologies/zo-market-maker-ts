#!/usr/bin/env bash
#
# t2t-dist.sh — Show tick-to-trade latency distribution from docker compose logs.
# Usage: ./scripts/t2t-dist.sh [symbol ...]
#   No args  → all services
#   With args → only those symbols (e.g. ./scripts/t2t-dist.sh btc eth)

set -euo pipefail
cd "$(dirname "$0")/.."

SYMBOLS=("$@")

# If no symbols given, discover from docker-compose
if [ ${#SYMBOLS[@]} -eq 0 ]; then
    SYMBOLS=($(docker compose config --services | sed 's/^mm-//' | sort))
fi

for sym in "${SYMBOLS[@]}"; do
    sym_lower=$(echo "$sym" | tr '[:upper:]' '[:lower:]')
    sym_upper=$(echo "$sym" | tr '[:lower:]' '[:upper:]')
    service="mm-${sym_lower}"

    # Extract t2t values from logs
    values=$(docker compose logs "$service" 2>/dev/null \
        | grep -oP 't2t=\K[0-9]+(\.[0-9]+)?' \
        || true)

    if [ -z "$values" ]; then
        echo "=== ${sym_upper}: no t2t data ==="
        echo
        continue
    fi

    count=$(echo "$values" | wc -l)

    # Compute stats and histogram with awk
    echo "$values" | awk -v sym="$sym_upper" '
    BEGIN {
        min = 999999; max = 0; sum = 0; n = 0
        # Histogram buckets (ms)
        split("0,5,10,15,20,30,50,75,100,150,200,500,1000", edges, ",")
        num_edges = 13
        for (i = 1; i <= num_edges + 1; i++) bucket[i] = 0
    }
    {
        v = $1 + 0
        samples[n] = v
        sum += v
        if (v < min) min = v
        if (v > max) max = v
        n++

        # Bucket assignment
        placed = 0
        for (i = 1; i <= num_edges; i++) {
            if (v < edges[i] + 0) {
                bucket[i]++
                placed = 1
                break
            }
        }
        if (!placed) bucket[num_edges + 1]++
    }
    END {
        if (n == 0) { print "=== " sym ": no t2t data ===\n"; exit }

        avg = sum / n

        # Sort for percentiles
        for (i = 0; i < n - 1; i++)
            for (j = i + 1; j < n; j++)
                if (samples[i] > samples[j]) {
                    tmp = samples[i]; samples[i] = samples[j]; samples[j] = tmp
                }

        p50 = samples[int(n * 0.50)]
        p90 = samples[int(n * 0.90)]
        p95 = samples[int(n * 0.95)]
        p99 = samples[int(n * 0.99)]

        printf "=== %s (%d samples) ===\n", sym, n
        printf "  min=%8.1fms  avg=%8.1fms  max=%8.1fms\n", min, avg, max
        printf "  p50=%8.1fms  p90=%8.1fms  p95=%8.1fms  p99=%8.1fms\n\n", p50, p90, p95, p99

        # Histogram
        max_bar = 40
        max_count = 0
        for (i = 1; i <= num_edges + 1; i++)
            if (bucket[i] > max_count) max_count = bucket[i]

        labels[1]  = "   < 5ms"
        labels[2]  = "  5-10ms"
        labels[3]  = " 10-15ms"
        labels[4]  = " 15-20ms"
        labels[5]  = " 20-30ms"
        labels[6]  = " 30-50ms"
        labels[7]  = " 50-75ms"
        labels[8]  = "75-100ms"
        labels[9]  = "100-150ms"
        labels[10] = "150-200ms"
        labels[11] = "200-500ms"
        labels[12] = " 500ms-1s"
        labels[13] = "    > 1s "
        labels[14] = "    > 1s "

        for (i = 1; i <= num_edges + 1; i++) {
            if (bucket[i] == 0) continue
            bar_len = int(bucket[i] / max_count * max_bar)
            if (bar_len == 0 && bucket[i] > 0) bar_len = 1
            bar = ""
            for (b = 0; b < bar_len; b++) bar = bar "█"
            pct = bucket[i] / n * 100
            printf "  %s │ %-40s %5d (%5.1f%%)\n", labels[i], bar, bucket[i], pct
        }
        printf "\n"
    }'
done
