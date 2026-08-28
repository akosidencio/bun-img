# Linux verification — ready to run, not yet run

The one open Phase 0 gate item. Everything here is prepared and tested up to the
point of needing a working Docker engine.

## Run it

```sh
docker run --rm \
  -v "$(cd ../.. && pwd)":/src:ro \
  -v "$(pwd)/../results-linux":/out \
  --platform linux/amd64 \
  oven/bun:1.4-slim \
  sh /src/benchmarks/linux/run.sh
```

`linux/amd64` is native on an Intel Mac host, so its throughput numbers are
meaningful. `linux/arm64` would run emulated — capability and alpha results from
it are still valid, but ignore its timings.

## Status, 2026-08-28

Docker Desktop 4.60.1 is installed and its UI launches, but the Linux engine
never comes up: `docker version` reports no server, `docker context` is correctly
set to `desktop-linux`, and the backend log has written nothing since the
previous day. Its own UI console log shows:

```
error  {"message":"could not retrieve Desktop settings, check if Docker Desktop
        is installed properly"}
```

That is an install-integrity problem on the host, not something the benchmark
setup can work around.

## What was substituted meanwhile

`backend-bench.ts` measures `Bun.Image.backend = "bun"` on the host, which is the
same Highway geometry path a Linux build uses and which Bun documents as
byte-identical to Linux. It covers the geometry half of the question. It does
**not** cover glibc/musl codec builds, container thread-pool behaviour, or arm64.
