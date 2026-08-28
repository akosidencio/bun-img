# benchmarks

Everything behind the numbers in [README.md](../README.md) and
[docs/phase0-findings.md](../docs/phase0-findings.md).

**All published figures are linux/amd64.** Results from other platforms are not
published — they varied enough to tell a materially different, and misleading,
story about performance. Run everything through the container:

```sh
docker run --rm --platform linux/amd64 \
  -v "$PWD":/src:ro -v "$PWD/benchmarks/results-linux":/out \
  oven/bun:1.4-slim sh /src/benchmarks/linux/run.sh
```

Sharp is installed only here, as the comparison instrument. It is never a
dependency of `@bun-img/core`, and a test enforces that.

## Scripts

| Script | Answers |
|---|---|
| `prepare-fixtures.ts` | Builds the fixture set from real photographic sources, plus an alpha PNG. Fixtures are gitignored — 14 MB, machine-specific, and rebuilt by this script. |
| `behaviour-probe.ts` | The capability matrix, and what `.jpeg()` does to an alpha source. |
| `quality-bench.ts` | Bytes at matched SSIM, bun vs sharp. **The kill gate.** |
| `throughput-bench.ts` | Warm ops/sec across concurrency levels. |
| `mem-bench.ts` | Cold start and peak RSS, each sample a fresh process. |
| `growth-bench.ts` | RSS trajectory over 600 sustained transforms. |
| `backend-geometry.ts` | Whether `Bun.Image.backend` changes output. Supersedes `backend-bench.ts`. |
| `load-test.ts` | The HTTP endpoint under sustained concurrency (spec P0). |
| `genfix.ts` | Regenerates the embedded decode-probe samples in `core/src/probe-samples.ts`. |

`ssim.ts` and `fixtures.ts` are shared helpers, not benchmarks.

## Method notes

Three of these are easy to get quietly wrong, and were:

**Compare each encoder against its own resize output.** `quality-bench.ts` emits
a lossless PNG reference per engine before sweeping quality, which isolates
*encoder* quality from *resampler* quality. Comparing bytes at a matched
`quality:` number across engines would be meaningless — the two scales are not
the same scale.

**Never measure a geometry difference through a lossy encode.** The first
backend comparison compared two independently q75-encoded outputs and reported a
difference roughly 21× larger than the real one. `backend-geometry.ts` uses
lossless PNG on both sides.

**A load test must prove it loaded something.** `load-test.ts` gates on validity
— error rate, throughput collapse, request count, and whether RSS could be read
at all — *before* it gates on memory. A stalled run has beautifully flat memory
because it is doing nothing, and without those gates that reads as a pass.

Two harness bugs that gate caught, both of which had produced a confident-looking
green result:

- The driver piped the server's stdout and never drained it. Once the ~64 KB
  pipe buffer filled, the server blocked on `write` and stopped serving. It
  looked like socket exhaustion.
- `Bun.file().exists()` returns false for `/proc/<pid>/status`, because procfs
  reports size 0. RSS silently read as zero, so "flat memory" meant "no memory
  data at all".
