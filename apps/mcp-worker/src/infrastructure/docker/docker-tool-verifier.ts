import type { ArtifactInspectionJob, ManagedMcpManifest } from "@open-agent-tools/mcp-contracts";

import { NODE20_BUILD_IMAGE } from "./docker-build-command.js";
import { ToolPackageVerificationError } from "../../services/tool-build.js";

export interface VerificationContainerCreateOptions {
  Image: string;
  Cmd: string[];
  Env: string[];
  User: "node";
  WorkingDir: "/workspace";
  HostConfig: {
    AutoRemove: false;
    NetworkMode: "none";
    ReadonlyRootfs: true;
    CapDrop: ["ALL"];
    SecurityOpt: ["no-new-privileges:true"];
    PidsLimit: number;
    Memory: number;
    NanoCpus: number;
    Binds: string[];
    Tmpfs: Record<string, string>;
  };
}

export interface VerificationContainer {
  start(): Promise<unknown>;
  wait(): Promise<{ StatusCode: number }>;
  kill(options?: { signal?: string }): Promise<unknown>;
  remove(options?: { force?: boolean }): Promise<unknown>;
}

export interface VerificationDockerClient {
  createContainer(options: VerificationContainerCreateOptions): Promise<VerificationContainer>;
}

const SMOKE_SCRIPT = `
const spec = JSON.parse(process.env.MCP_SMOKE_SPEC);
let moduleValue;
try {
  moduleValue = await import('file:///workspace/' + spec.entry + '?smoke=' + spec.requestId);
} catch {
  process.exit(42);
}
for (const tool of spec.tools) {
  const handler = moduleValue.handlers?.[tool.handler];
  if (typeof handler !== 'function') process.exit(42);
  let result;
  try {
    result = await handler({}, {
      requestId: spec.requestId,
      serviceId: spec.serviceId,
      versionId: spec.versionId,
      clientId: 'build-worker'
    });
  } catch {
    process.exit(43);
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.content)) process.exit(43);
  try { JSON.stringify(result); } catch { process.exit(43); }
}
`;

export class DockerToolPackageVerifier {
  readonly #docker: VerificationDockerClient;
  readonly #image: string;

  constructor(docker: VerificationDockerClient, image = NODE20_BUILD_IMAGE) {
    this.#docker = docker;
    this.#image = image;
  }

  async verify(
    packageRoot: string,
    manifest: ManagedMcpManifest,
    job: ArtifactInspectionJob,
  ): Promise<void> {
    if (manifest.entry === undefined) {
      throw new ToolPackageVerificationError("HANDLER_NOT_FOUND");
    }
    const limits = manifest.limits ?? {
      timeoutMs: 30_000,
      memoryMb: 256,
      cpuMillis: 1_000,
      network: "none" as const,
    };
    const container = await this.#docker.createContainer({
      Image: this.#image,
      Cmd: ["node", "--input-type=module", "--eval", SMOKE_SCRIPT],
      Env: [
        `MCP_SMOKE_SPEC=${JSON.stringify({
          entry: manifest.entry,
          tools: manifest.tools,
          requestId: `build-smoke-${job.buildJobId}`,
          serviceId: job.serviceId,
          versionId: job.versionId,
        })}`,
      ],
      User: "node",
      WorkingDir: "/workspace",
      HostConfig: {
        AutoRemove: false,
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 64,
        Memory: limits.memoryMb * 1024 * 1024,
        NanoCpus: limits.cpuMillis * 1_000_000,
        Binds: [`${packageRoot}:/workspace:ro`],
        Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16777216" },
      },
    });
    try {
      await container.start();
      const wait = container.wait();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        wait.then(() => false),
        new Promise<true>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(true), limits.timeoutMs);
        }),
      ]);
      if (timedOut) {
        await container.kill({ signal: "SIGKILL" }).catch(() => undefined);
        await wait.catch(() => ({ StatusCode: 137 }));
        throw new ToolPackageVerificationError("SMOKE_TEST_FAILED");
      }
      if (timer) clearTimeout(timer);
      const statusCode = (await wait).StatusCode;
      if (statusCode === 42) throw new ToolPackageVerificationError("HANDLER_NOT_FOUND");
      if (statusCode !== 0) throw new ToolPackageVerificationError("SMOKE_TEST_FAILED");
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }
}
