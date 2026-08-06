import type { BuildCommandRunner } from "../../services/tool-build.js";

export const NODE20_BUILD_IMAGE =
  "node:20.20.2-alpine3.23@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293";

export interface BuildContainerCreateOptions {
  Image: string;
  Cmd: string[];
  User: "node";
  WorkingDir: "/workspace";
  HostConfig: {
    AutoRemove: false;
    NetworkMode: string;
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

export interface BuildContainer {
  start(): Promise<unknown>;
  wait(): Promise<{ StatusCode: number }>;
  kill(options?: { signal?: string }): Promise<unknown>;
  remove(options?: { force?: boolean }): Promise<unknown>;
}

export interface BuildDockerClient {
  createContainer(options: BuildContainerCreateOptions): Promise<BuildContainer>;
}

export interface DockerBuildCommandRunnerOptions {
  image?: string;
  installNetwork?: string;
  timeoutMs?: number;
  memoryMb?: number;
  cpuMillis?: number;
}

function isAllowedNpmCommand(args: string[]): boolean {
  return (
    JSON.stringify(args) ===
      JSON.stringify(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]) ||
    JSON.stringify(args) === JSON.stringify(["run", "build"])
  );
}

export class DockerBuildCommandRunner implements BuildCommandRunner {
  readonly #docker: BuildDockerClient;
  readonly #image: string;
  readonly #installNetwork: string;
  readonly #timeoutMs: number;
  readonly #memoryMb: number;
  readonly #cpuMillis: number;

  constructor(docker: BuildDockerClient, options: DockerBuildCommandRunnerOptions = {}) {
    this.#docker = docker;
    this.#image = options.image ?? NODE20_BUILD_IMAGE;
    this.#installNetwork = options.installNetwork ?? "bridge";
    this.#timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    this.#memoryMb = options.memoryMb ?? 512;
    this.#cpuMillis = options.cpuMillis ?? 2_000;
  }

  async run(command: string, args: string[], options: { cwd: string }) {
    if (command !== "npm" || !isAllowedNpmCommand(args)) {
      throw new TypeError("Unsupported build command");
    }
    const container = await this.#docker.createContainer({
      Image: this.#image,
      Cmd: [command, ...args],
      User: "node",
      WorkingDir: "/workspace",
      HostConfig: {
        AutoRemove: false,
        NetworkMode: args[0] === "ci" ? this.#installNetwork : "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 128,
        Memory: this.#memoryMb * 1024 * 1024,
        NanoCpus: this.#cpuMillis * 1_000_000,
        Binds: [`${options.cwd}:/workspace:rw`],
        Tmpfs: {
          "/tmp": "rw,noexec,nosuid,nodev,size=67108864",
          "/home/node/.npm": "rw,nosuid,nodev,size=268435456",
        },
      },
    });

    try {
      await container.start();
      const wait = container.wait();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        wait.then(() => false),
        new Promise<true>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(true), this.#timeoutMs);
        }),
      ]);
      if (!timedOut) {
        if (timer) clearTimeout(timer);
        return { exitCode: (await wait).StatusCode, stdout: "", stderr: "" };
      }
      await container.kill({ signal: "SIGKILL" }).catch(() => undefined);
      await wait.catch(() => ({ StatusCode: 137 }));
      return { exitCode: 124, stdout: "", stderr: "build command timed out" };
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }
}
