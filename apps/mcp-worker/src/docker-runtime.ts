import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolExecutionJob } from "@open-agent-tools/mcp-contracts";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ContainerCreateOptions {
  Image: string;
  Name?: string;
  User: string;
  WorkingDir: string;
  Labels: Record<string, string>;
  HostConfig: {
    AutoRemove: boolean;
    NetworkMode: "none";
    ReadonlyRootfs: boolean;
    CapDrop: ["ALL"];
    SecurityOpt: ["no-new-privileges:true"];
    PidsLimit: number;
    Memory: number;
    NanoCpus: number;
    Binds: string[];
    Tmpfs: Record<string, string>;
  };
}

export interface DockerContainer {
  start(): Promise<unknown>;
  wait(): Promise<{ StatusCode: number }>;
  kill(options?: { signal?: string }): Promise<unknown>;
  remove(options?: { force?: boolean }): Promise<unknown>;
}

export interface DockerClient {
  createContainer(options: ContainerCreateOptions): Promise<DockerContainer>;
}

export interface DockerClientOptions {
  socketPath?: string;
}

export interface DockerToolRuntimeOptions {
  imageRepository: string;
}

export interface DockerToolRuntimeDependencies {
  now?: () => number;
  onError?: (error: unknown) => void;
}

function errorResult(code: string, requestId: string): CallToolResult {
  return {
    content: [{ type: "text", text: "Tool execution failed." }],
    isError: true,
    _meta: { "open-agent-tools/error": { code, requestId } },
  };
}

async function readOutput(path: string, requestId: string): Promise<CallToolResult> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      return errorResult("INVALID_OUTPUT", requestId);
    }
    if (metadata.size > MAX_OUTPUT_BYTES) {
      return errorResult("OUTPUT_LIMIT", requestId);
    }

    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.nlink !== 1 || current.size > MAX_OUTPUT_BYTES) {
        return errorResult("INVALID_OUTPUT", requestId);
      }
      const parsed = CallToolResultSchema.safeParse(
        JSON.parse(await handle.readFile("utf8")) as unknown,
      );
      return parsed.success ? parsed.data : errorResult("INVALID_OUTPUT", requestId);
    } finally {
      await handle.close();
    }
  } catch {
    return errorResult("INVALID_OUTPUT", requestId);
  }
}

async function waitWithTimeout(
  container: DockerContainer,
  timeoutMs: number,
): Promise<{ timedOut: boolean; statusCode: number }> {
  const wait = container.wait();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    wait.then(() => false),
    new Promise<true>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(true), timeoutMs);
    }),
  ]);

  if (!timedOut) {
    if (timer) clearTimeout(timer);
    return { timedOut: false, statusCode: (await wait).StatusCode };
  }

  try {
    await container.kill({ signal: "SIGKILL" });
  } catch {
    // The container may have exited between the timeout and kill request.
  }
  const status = await wait.catch(() => ({ StatusCode: 137 }));
  return { timedOut: true, statusCode: status.StatusCode };
}

export class DockerToolContainerRuntime {
  readonly #docker: DockerClient;
  readonly #imageRepository: string;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;

  constructor(
    docker: DockerClient,
    options: DockerToolRuntimeOptions,
    dependencies: DockerToolRuntimeDependencies = {},
  ) {
    this.#docker = docker;
    this.#imageRepository = options.imageRepository.replace(/@.*$/, "");
    this.#now = dependencies.now ?? Date.now;
    this.#onError = dependencies.onError ?? (() => undefined);
  }

  async execute(job: ToolExecutionJob): Promise<CallToolResult> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "mcp-tool-execution-"));
    const outputDirectory = join(temporaryRoot, "output");
    const inputPath = join(temporaryRoot, "input.json");
    let container: DockerContainer | undefined;

    try {
      await mkdir(outputDirectory, { mode: 0o733 });
      await chmod(outputDirectory, 0o733);
      await writeFile(
        inputPath,
        JSON.stringify({
          requestId: job.requestId,
          toolName: job.toolName,
          arguments: job.arguments,
          context: {
            serviceId: job.serviceId,
            versionId: job.versionId,
            clientId: job.context.clientId,
            deadlineAt: job.context.deadlineAt,
          },
        }),
        { mode: 0o444 },
      );

      container = await this.#docker.createContainer({
        Image:
          this.#imageRepository.length === 0
            ? job.imageDigest
            : `${this.#imageRepository}@${job.imageDigest}`,
        Name: `mcp-tool-${job.toolName}-${job.requestId}`,
        User: "node",
        WorkingDir: "/app",
        Labels: {
          "io.open-agent-tools.mcp.request-id": job.requestId,
          "io.open-agent-tools.mcp.service-id": job.serviceId,
          "io.open-agent-tools.mcp.version-id": job.versionId,
        },
        HostConfig: {
          AutoRemove: false,
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 64,
          Memory: job.limits.memoryMb * 1024 * 1024,
          NanoCpus: job.limits.cpuMillis * 1_000_000,
          Binds: [`${outputDirectory}:/run/tool:rw`, `${inputPath}:/run/tool/input.json:ro`],
          Tmpfs: {
            "/tmp": "rw,noexec,nosuid,nodev,size=16777216",
          },
        },
      });
      await container.start();

      const deadlineRemaining = Date.parse(job.context.deadlineAt) - this.#now();
      const timeoutMs = Math.max(1, Math.min(job.limits.timeoutMs, deadlineRemaining));
      const outcome = await waitWithTimeout(container, timeoutMs);
      if (outcome.timedOut) return errorResult("TIMEOUT", job.requestId);
      if (outcome.statusCode !== 0) return errorResult("CONTAINER_EXIT", job.requestId);

      return await readOutput(join(outputDirectory, "output.json"), job.requestId);
    } catch (error) {
      this.#onError(error);
      return errorResult("CONTAINER_FAILED", job.requestId);
    } finally {
      if (container) {
        await container.remove({ force: true }).catch(() => undefined);
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

export async function createDockerClient(options: DockerClientOptions = {}): Promise<DockerClient> {
  const module = (await import("dockerode")) as unknown as {
    default: new (options?: DockerClientOptions) => DockerClient;
  };
  return new module.default(options);
}
