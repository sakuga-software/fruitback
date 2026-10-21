# The four images that `ci.yml` builds and boots, built side by side by one `docker buildx bake`
# (FRU-344): one after the other they took 2 to 3 minutes of the job.
#
# The layers are cached in the registry, not in the cache of GitHub Actions, which they filled
# (9.5 GB of its 10.6 in October 2026) until it evicted the store of pnpm. A run reads the cache of
# `CACHE_REPO`, and writes it only when `CACHE_WRITE` is true: only the job `layer-cache` of
# release-image.yml sets it, after CI passed on `main`, so no pull request writes layers that a
# later build reads.

variable "CACHE_REPO" {
  default = ""
}

variable "CACHE_WRITE" {
  default = false
}

function "cache_from" {
  params = [name]
  result = CACHE_REPO == "" ? [] : ["type=registry,ref=${CACHE_REPO}:${name}"]
}

function "cache_to" {
  params = [name]
  result = CACHE_REPO != "" && CACHE_WRITE ? ["type=registry,ref=${CACHE_REPO}:${name},mode=max"] : []
}

group "ci" {
  targets = ["worker", "playground", "console", "console-cloud"]
}

target "worker" {
  context    = "."
  dockerfile = "apps/worker/Dockerfile"
  tags       = ["fruitback-worker:ci"]
  cache-from = cache_from("worker")
  cache-to   = cache_to("worker")
}

# FRU-79. Dokploy builds this Dockerfile on push too. It is not published anywhere.
target "playground" {
  context    = "."
  dockerfile = "apps/playground/Dockerfile"
  tags       = ["fruitback-playground:ci"]
  cache-from = cache_from("playground")
  cache-to   = cache_to("playground")
}

# FRU-222. The image that is published: built with no address of a worker in it.
target "console" {
  context    = "."
  dockerfile = "apps/console/Dockerfile"
  tags       = ["fruitback-console:ci"]
  cache-from = cache_from("console")
  cache-to   = cache_to("console")
}

# FRU-99, kept by FRU-222. The console as Dokploy builds it for the Cloud: the address is a build
# argument. Its layers before that argument are those of `console`.
target "console-cloud" {
  context    = "."
  dockerfile = "apps/console/Dockerfile"
  tags       = ["fruitback-console:cloud"]
  args = {
    VITE_FRUITBACK_API = "https://api.fruitback.example"
  }
  cache-from = cache_from("console")
}
