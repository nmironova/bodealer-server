#!/bin/sh
# Build Linux binaries without writing to the native source checkout.
set -eu
source_dir=${1:-../BoDealer}
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir=$(CDPATH= cd -- "$source_dir" && pwd)
if [ ! -f "$source_dir/CMakeLists.txt" ]; then
  echo "Expected a BoDealer CMake checkout: $source_dir" >&2
  exit 1
fi
context=$(mktemp -d "${TMPDIR:-/tmp}/bodealer-native.XXXXXX")
container="bodealer-native-copy-$$"
created=false
cleanup() {
  if [ "$created" = true ]; then docker rm "$container" >/dev/null; fi
  rm -rf "$context"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$context/src/sln"
cp "$source_dir/CMakeLists.txt" "$context/src/"
cp -R "$source_dir/walrus" "$source_dir/dds-develop" "$context/src/"
cp -R "$source_dir/sln/Oscar" "$context/src/sln/"
cat > "$context/Dockerfile" <<'BUILD'
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake libncurses-dev && rm -rf /var/lib/apt/lists/*
COPY src/ /src/
RUN cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF \
    && cmake --build /build --parallel 2
FROM scratch
COPY --from=build /build/bin/walrus /walrus
COPY --from=build /build/bin/oscar /oscar
CMD ["/walrus"]
BUILD
docker build -t bodealer-native-build:local "$context"
docker create --name "$container" bodealer-native-build:local >/dev/null
created=true
docker cp "$container:/walrus" "$context/walrus"
docker cp "$container:/oscar" "$context/oscar"
mkdir -p "$repo_dir/exes/linux"
chmod 755 "$context/walrus" "$context/oscar"
cp "$context/walrus" "$repo_dir/exes/linux/walrus"
cp "$context/oscar" "$repo_dir/exes/linux/oscar"
echo "Linux solvers written to $repo_dir/exes/linux (architecture follows Docker's selected platform)."
