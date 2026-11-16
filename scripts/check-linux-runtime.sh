#!/bin/sh
set -eu
runtime=${1:-/app/exes/linux}
for name in walrus oscar; do
  binary="$runtime/$name"
  if [ ! -f "$binary" ]; then
    echo "Missing Linux solver: $binary. Build both solvers for this image's Linux architecture; see README." >&2
    exit 1
  fi
  chmod 755 "$binary"
  file "$binary"
  file "$binary" | grep -q ELF || { echo "Expected Linux ELF binary: $binary" >&2; exit 1; }
  # ldd also rejects incompatible loaders/architectures. Accept genuinely static ELF.
  if readelf -l "$binary" | grep -q INTERP; then
    dependencies=$(ldd "$binary") || exit 1
    echo "$dependencies"
    if echo "$dependencies" | grep -q 'not found'; then
      echo "Missing native dependency for $binary" >&2
      exit 1
    fi
  else
    readelf -h "$binary"
    # Ensure a static build also matches the container's architecture.
    case "$(uname -m)" in
      aarch64) readelf -h "$binary" | grep -q AArch64 ;;
      x86_64) readelf -h "$binary" | grep -q 'Advanced Micro Devices X86-64' ;;
      *) echo 'Unsupported solver validation architecture' >&2; exit 1 ;;
    esac
  fi
done
