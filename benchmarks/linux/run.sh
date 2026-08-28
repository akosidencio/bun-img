#!/bin/sh
# Phase 0 Linux verification — runs inside oven/bun:1.4-slim.
#
# The host repo is mounted read-only at /src so a container install can never
# clobber the host's darwin node_modules. Everything is copied to /work first.
# Results are written to /out, which is bind-mounted back to the host.
set -eu

echo "=== host ==="
echo "bun      $(bun --version)"
echo "platform $(uname -s)/$(uname -m)"
echo "libc     $(ldd --version 2>&1 | head -1 || echo unknown)"
echo "cpus     $(nproc)"
echo "mem      $(awk '/MemTotal/{printf "%.1f GB", $2/1048576}' /proc/meminfo)"
echo ""

mkdir -p /work
cp -r /src/benchmarks/. /work/
rm -rf /work/node_modules /work/results /work/linux
mkdir -p /work/results

cd /work

# sharp for linux — pulls @img/sharp-linux-* and libvips
echo "=== installing sharp (linux) ==="
bun install --no-save sharp@0.34.5 2>&1 | tail -4
echo ""
echo "sharp install size: $(du -sh node_modules | cut -f1) across $(ls node_modules/@img 2>/dev/null | wc -l) @img packages"
echo ""

# The capability + alpha probe is the correctness half of the gate.
echo "=== behaviour probe ==="
bun behaviour-probe.ts 2>&1 || echo "BEHAVIOUR PROBE FAILED"
echo ""

echo "=== quality (webp/jpeg bytes at matched SSIM) ==="
bun quality-bench.ts 2>&1 | tail -32 || echo "QUALITY BENCH FAILED"
echo ""

echo "=== throughput ==="
bun throughput-bench.ts 2>&1 | tail -36 || echo "THROUGHPUT BENCH FAILED"
echo ""

echo "=== memory + cold start ==="
bun mem-bench.ts 2>&1 | tail -14 || echo "MEM BENCH FAILED"
echo ""

echo "=== sustained growth (bun) ==="
bun growth-bench.ts bun 2>&1 | tail -12 || echo "GROWTH BENCH FAILED"
echo ""

cp -r /work/results/. /out/ 2>/dev/null || true
echo "=== done, results copied to /out ==="
