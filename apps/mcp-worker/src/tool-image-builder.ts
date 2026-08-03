import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NODE20_BUILD_IMAGE } from "./docker-build-command.js";
import type { ToolImageBuilder } from "./tool-build.js";

export interface PlatformCommandRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface SbomStorage {
  upload(objectKey: string, path: string): Promise<void>;
}

export interface DockerCliToolImageBuilderOptions {
  imageRepository: string;
  runnerImage: string;
  /** 带 npm 的精简镜像，用于在最终镜像中裁剪 devDependencies；默认使用 NODE20_BUILD_IMAGE */
  pruneImage?: string;
  attestations?: boolean;
  tempDirectory?: string;
}

function requirePinnedImage(image: string): string {
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new TypeError("runnerImage must be pinned by SHA-256 digest");
  }
  return image;
}

function requireTag(imageTag: string): string {
  const separator = imageTag.lastIndexOf(":");
  const tag = separator >= 0 ? imageTag.slice(separator + 1) : imageTag;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(tag)) {
    throw new TypeError("Invalid image tag");
  }
  return tag;
}

function requireDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("Image builder did not return a registry digest");
  }
  return value;
}

export class DockerCliToolImageBuilder implements ToolImageBuilder {
  readonly #commands: PlatformCommandRunner;
  readonly #sbom: SbomStorage;
  readonly #imageRepository: string;
  readonly #runnerImage: string;
  readonly #pruneImage: string;
  readonly #attestations: boolean;
  readonly #tempDirectory: string;

  constructor(
    commands: PlatformCommandRunner,
    sbom: SbomStorage,
    options: DockerCliToolImageBuilderOptions,
  ) {
    this.#commands = commands;
    this.#sbom = sbom;
    this.#imageRepository = options.imageRepository.replace(/[:/]$/, "");
    this.#runnerImage = requirePinnedImage(options.runnerImage);
    this.#pruneImage = requirePinnedImage(options.pruneImage ?? NODE20_BUILD_IMAGE);
    this.#attestations = options.attestations ?? true;
    this.#tempDirectory = options.tempDirectory ?? tmpdir();
  }

  async build(context: string, imageTag: string) {
    const tag = requireTag(imageTag);
    const imageReference = `${this.#imageRepository}:${tag}`;
    const workDirectory = await mkdtemp(join(this.#tempDirectory, "mcp-image-build-"));
    const dockerfile = join(workDirectory, "Dockerfile");
    const metadataPath = join(workDirectory, "metadata.json");
    const sbomPath = join(workDirectory, "sbom.cdx.json");
    const sbomObjectKey = `sbom/${tag}.cdx.json`;
    try {
      await writeFile(
        dockerfile,
        [
          "ARG RUNNER_IMAGE",
          "ARG PRUNE_IMAGE",
          "FROM ${PRUNE_IMAGE} AS prune",
          "USER root",
          "COPY --chown=node:node . /build",
          "WORKDIR /build",
          "RUN npm prune --omit=dev --no-audit --no-fund",
          "USER node",
          "",
          "FROM ${RUNNER_IMAGE}",
          "USER root",
          "COPY --from=prune --chown=node:node /build /app",
          "USER node",
          "",
        ].join("\n"),
        { flag: "wx", mode: 0o600 },
      );
      const built = await this.#commands.run("docker", [
        "buildx",
        "build",
        "--push",
        ...(this.#attestations ? ["--provenance=true", "--sbom=true"] : []),
        "--metadata-file",
        metadataPath,
        "--file",
        dockerfile,
        "--tag",
        imageReference,
        "--build-arg",
        `RUNNER_IMAGE=${this.#runnerImage}`,
        "--build-arg",
        `PRUNE_IMAGE=${this.#pruneImage}`,
        context,
      ]);
      if (built.exitCode !== 0) throw new Error("Image build and push failed");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
      const imageDigest = requireDigest(metadata["containerimage.digest"]);
      const digestReference = `${imageReference}@${imageDigest}`;

      const generated = await this.#commands.run("syft", [
        digestReference,
        "-o",
        `cyclonedx-json=${sbomPath}`,
      ]);
      if (generated.exitCode !== 0) throw new Error("SBOM generation failed");
      const scanned = await this.#commands.run("trivy", [
        "image",
        "--quiet",
        "--exit-code",
        "1",
        "--severity",
        "HIGH,CRITICAL",
        digestReference,
      ]);
      if (scanned.exitCode !== 0) {
        throw new Error("Vulnerability policy rejected image");
      }
      await this.#sbom.upload(sbomObjectKey, sbomPath);
      return { imageDigest, sbomObjectKey };
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}
