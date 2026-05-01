import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "@/lib/logger";
import { updateCheckCache, CACHE_TTL } from "@/lib/cache";
import { env } from "@/lib/env";

const execFileAsync = promisify(execFile);

interface DockerHubTag {
  name: string;
  last_updated?: string;
  digest?: string;
}

interface GhcrTokenResponse {
  token?: string;
}

interface GhcrTagsListResponse {
  tags?: string[];
}

interface GhcrManifestResponse {
  config?: {
    digest?: string;
  };
  manifests?: Array<{
    digest?: string;
  }>;
}

interface VersionInfo {
  currentVersion: string;
  currentDigest: string;
  latestVersion: string;
  latestDigest: string;
  updateAvailable: boolean;
  buildInProgress: boolean;
  availableVersions: string[];
}

interface GitHubRunsResponse {
  total_count?: number;
}

async function getDockerHubTags(imageName: string, skipCache = false): Promise<DockerHubTag[]> {
  const imagePath = imageName.replace(/^https?:\/\//, "").replace(/^docker\.io\//, "").replace(/^ghcr\.io\//, "");
  const cacheKey = `docker-hub-tags:${imagePath}`;

  if (!skipCache) {
    const cached = updateCheckCache.get(cacheKey) as DockerHubTag[] | null;
    if (cached) return cached;
  }

  const response = await fetch(
    `https://hub.docker.com/v2/repositories/${imagePath}/tags?page_size=20`,
    { cache: "no-store" }
  );

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Failed to fetch Docker Hub tags");
  }

  const data = await response.json();
  const tags: DockerHubTag[] = data.results || [];
  updateCheckCache.set(cacheKey, tags, CACHE_TTL.DOCKER_HUB_TAGS);
  return tags;
}

function extractGhcrRepositoryPath(imageName: string): string {
  const normalized = imageName.replace(/^https?:\/\//, "");
  if (normalized.startsWith("ghcr.io/")) {
    return normalized.substring("ghcr.io/".length);
  }
  return normalized;
}

async function getGhcrTagsFromRegistryV2(imageName: string, skipCache = false): Promise<DockerHubTag[]> {
  const cacheKey = `ghcr-tags:${imageName}`;

  if (!skipCache) {
    const cached = updateCheckCache.get(cacheKey) as DockerHubTag[] | null;
    if (cached) return cached;
  }

  try {
    const repository = extractGhcrRepositoryPath(imageName);

    const tokenResponse = await fetch(
      `https://ghcr.io/token?service=ghcr.io&scope=repository:${encodeURIComponent(repository)}:pull`,
      { cache: "no-store" }
    );

    if (!tokenResponse.ok) {
      await tokenResponse.body?.cancel();
      return [];
    }

    const tokenData = (await tokenResponse.json()) as GhcrTokenResponse;
    const token = tokenData.token;
    if (!token) {
      return [];
    }

    const tagsResponse = await fetch(`https://ghcr.io/v2/${repository}/tags/list`, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!tagsResponse.ok) {
      await tagsResponse.body?.cancel();
      return [];
    }

    const tagsData = (await tagsResponse.json()) as GhcrTagsListResponse;
    const allTags = tagsData.tags || [];

    const latestIncluded = allTags.includes("latest");
    const versionTags = allTags.filter((tag) => tag.startsWith("v"));

    const manifestEntries = await Promise.all(
      versionTags.map(async (tag) => {
        try {
          const manifestHeadResponse = await fetch(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
            method: "HEAD",
            cache: "no-store",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.oci.image.index.v1+json",
            },
          });

          // Docker-Content-Digest header contains the manifest list digest,
          // which matches RepoDigests from docker inspect (used for version resolution)
          const headDigest = manifestHeadResponse.headers.get("docker-content-digest");
          if (manifestHeadResponse.ok && headDigest) {
            return { name: tag, digest: headDigest.replace("sha256:", "") };
          }

          // Fallback: GET manifest body when HEAD unavailable/missing digest
          const manifestResponse = await fetch(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
            cache: "no-store",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.oci.image.index.v1+json",
            },
          });

          if (!manifestResponse.ok) {
            return { name: tag } as DockerHubTag;
          }

          const manifestData = (await manifestResponse.json()) as GhcrManifestResponse;
          const digest = manifestData.config?.digest || manifestData.manifests?.[0]?.digest;

          return digest ? { name: tag, digest } : { name: tag };
        } catch {
          return { name: tag };
        }
      })
    );

    let latestTag: DockerHubTag | null = null;
    if (latestIncluded) {
      try {
        const latestHeadResponse = await fetch(`https://ghcr.io/v2/${repository}/manifests/latest`, {
          method: "HEAD",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.oci.image.index.v1+json",
          },
        });

        // Docker-Content-Digest header contains the manifest list digest,
        // which matches RepoDigests from docker inspect (used for version resolution)
        const latestHeadDigest = latestHeadResponse.headers.get("docker-content-digest");
        if (latestHeadResponse.ok && latestHeadDigest) {
          latestTag = { name: "latest", digest: latestHeadDigest.replace("sha256:", "") };
        } else {
          const latestManifestResponse = await fetch(`https://ghcr.io/v2/${repository}/manifests/latest`, {
            cache: "no-store",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.oci.image.index.v1+json",
            },
          });

          if (latestManifestResponse.ok) {
            const latestManifestData = (await latestManifestResponse.json()) as GhcrManifestResponse;
            const latestDigest = latestManifestData.config?.digest || latestManifestData.manifests?.[0]?.digest;
            latestTag = latestDigest ? { name: "latest", digest: latestDigest } : { name: "latest" };
          } else {
            latestTag = { name: "latest" };
          }
        }
      } catch {
        latestTag = { name: "latest" };
      }
    }

    const tags = latestTag ? [latestTag, ...manifestEntries] : manifestEntries;
    updateCheckCache.set(cacheKey, tags, CACHE_TTL.DOCKER_HUB_TAGS);
    return tags;
  } catch {
    return [];
  }
}

async function getAvailableTags(skipCache = false): Promise<DockerHubTag[]> {
  if (env.IMAGE_REGISTRY === "ghcr") {
    return getGhcrTagsFromRegistryV2(env.IMAGE_NAME, skipCache);
  }

  return getDockerHubTags(env.IMAGE_NAME, skipCache);
}

async function getCurrentImageDigest(): Promise<{ version: string; digest: string; fullDigest: string; repoDigest: string }> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      env.CLIPROXYAPI_CONTAINER_NAME,
      "--format",
      "{{.Config.Image}} {{.Image}}",
    ]);
    
    const [image, fullDigest] = stdout.trim().split(" ");
    if (!image || !fullDigest) {
      return { version: "unknown", digest: "unknown", fullDigest: "unknown", repoDigest: "unknown" };
    }
    const [, imageTag] = image.split(":");
    const tagVersion = imageTag ?? "latest";
    const cleanDigest = fullDigest.replace("sha256:", "");
    
    // Get the manifest list digest from RepoDigests for accurate GHCR comparison
    let repoDigest = "unknown";
    try {
      const { stdout: repoDigestsJson } = await execFileAsync("docker", [
        "inspect", image,
        "--format", "{{json .RepoDigests}}",
      ]);
      const repoDigests: string[] = JSON.parse(repoDigestsJson.trim());
      const match = repoDigests.find((d) => d.startsWith(image.split(":")[0] + "@"));
      if (match) {
        repoDigest = match.split("@sha256:")[1] || "unknown";
      }
    } catch {
      // repoDigest stays "unknown"
    }
    
    return { 
      version: tagVersion, 
      digest: cleanDigest.substring(0, 12),
      fullDigest: cleanDigest,
      repoDigest,
    };
  } catch {
    return { version: "unknown", digest: "unknown", fullDigest: "unknown", repoDigest: "unknown" };
  }
}

async function checkGitHubBuildStatus(skipCache = false): Promise<boolean> {
  const cacheKey = "github-build-status:router-for-me/CLIProxyAPI";
  
  if (!skipCache) {
    const cached = updateCheckCache.get(cacheKey) as boolean | null;
    if (cached !== null) return cached;
  }

  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "cliproxyapi-dashboard/update-check",
    };
    const base = "https://api.github.com/repos/router-for-me/CLIProxyAPI/actions/runs?per_page=1";

    const [inProgressRes, queuedRes] = await Promise.all([
      fetch(`${base}&status=in_progress`, { cache: "no-store", headers }),
      fetch(`${base}&status=queued`, { cache: "no-store", headers }),
    ]);

    const [inProgressData, queuedData]: [GitHubRunsResponse, GitHubRunsResponse] = await Promise.all([
      inProgressRes.ok
        ? inProgressRes.json()
        : inProgressRes.body?.cancel().then(() => ({})) ?? Promise.resolve({}),
      queuedRes.ok
        ? queuedRes.json()
        : queuedRes.body?.cancel().then(() => ({})) ?? Promise.resolve({}),
    ]);

    const isBuilding = (inProgressData.total_count ?? 0) > 0 || (queuedData.total_count ?? 0) > 0;
    updateCheckCache.set(cacheKey, isBuilding, CACHE_TTL.GITHUB_BUILD_STATUS);
    return isBuilding;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const session = await verifySession();

  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { isAdmin: true },
  });

  if (!user?.isAdmin) {
    return NextResponse.json(
      { error: "Forbidden: Admin access required" },
      { status: 403 }
    );
  }

  // Check if refresh=true query param is present to skip cache
  const skipCache = request.nextUrl.searchParams.get("refresh") === "true";

  try {
    const [tags, current, buildInProgress] = await Promise.all([
      getAvailableTags(skipCache),
      getCurrentImageDigest(),
      checkGitHubBuildStatus(skipCache),
    ]);

    const latestTag = tags.find((t) => t.name === "latest");
    const latestDigest = latestTag?.digest
      ? latestTag.digest.replace("sha256:", "").substring(0, 12)
      : "unknown";

    const versionedTags = tags
      .filter((t) => t.name !== "latest" && t.name.startsWith("v"))
      .map((t) => ({ name: t.name, digest: t.digest?.replace("sha256:", "") || "" }))
      .sort((a, b) => {
        const aParts = a.name.replace("v", "").split(".").map(Number);
        const bParts = b.name.replace("v", "").split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if ((bParts[i] || 0) !== (aParts[i] || 0)) {
            return (bParts[i] || 0) - (aParts[i] || 0);
          }
        }
        return 0;
      });

    let resolvedCurrentVersion = current.version;
    // Use repoDigest (manifest list digest) for GHCR comparison, fallback to per-arch digest
    const compareDigest = current.repoDigest !== "unknown" ? current.repoDigest : current.fullDigest;
    if (current.version === "latest" && compareDigest !== "unknown") {
      const matchingTag = versionedTags.find((t) => 
        t.digest && t.digest.replace("sha256:", "").startsWith(compareDigest.substring(0, 12))
      );
      if (matchingTag) {
        resolvedCurrentVersion = matchingTag.name;
      }
    }

    const versionNames = versionedTags.map((t) => t.name);

    const updateAvailable = latestDigest !== "unknown"
      ? current.digest !== "unknown" && latestDigest !== (current.repoDigest !== "unknown" ? current.repoDigest.substring(0, 12) : current.digest)
      : versionNames.length > 0 && resolvedCurrentVersion !== versionNames[0];

    const versionInfo: VersionInfo = {
      currentVersion: resolvedCurrentVersion,
      currentDigest: current.digest,
      latestVersion: versionNames[0] || "latest",
      latestDigest,
      updateAvailable: buildInProgress ? false : updateAvailable,
      buildInProgress,
      availableVersions: versionNames.slice(0, 10),
    };

    return NextResponse.json(versionInfo);
  } catch (error) {
    logger.error({ err: error }, "Update check error");
    return NextResponse.json(
      { error: "Failed to check for updates" },
      { status: 500 }
    );
  }
}
