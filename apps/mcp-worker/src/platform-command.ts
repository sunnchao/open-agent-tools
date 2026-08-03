import { spawn } from "node:child_process";

import type { PlatformCommandRunner } from "./tool-image-builder.js";

export interface SpawnPlatformCommandRunnerOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class SpawnPlatformCommandRunner implements PlatformCommandRunner {
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: SpawnPlatformCommandRunnerOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  }

  async run(command: string, args: string[], options: { cwd?: string } = {}) {
    return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(command, args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let forced: { exitCode: number; stderr: string } | null = null;

      const terminate = (exitCode: number, message: string): void => {
        if (forced !== null) return;
        forced = { exitCode, stderr: message };
        child.kill("SIGKILL");
      };
      const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > this.#maxOutputBytes) {
          terminate(125, "Platform command exceeded output limit");
          return;
        }
        if (target === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };

      child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
      const timer = setTimeout(
        () => terminate(124, "Platform command timed out"),
        this.#timeoutMs,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ exitCode: 126, stdout, stderr: error.message });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (forced !== null) {
          resolve({ exitCode: forced.exitCode, stdout, stderr: forced.stderr });
          return;
        }
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }
}
