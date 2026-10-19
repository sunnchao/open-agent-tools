import { basename, extname, join, relative, sep } from "node:path";
import {
  type Connector,
  type ConnectorConfig,
  type ConnectorDeps,
  type ConnectorDocument,
  type ConnectorFileSystem,
} from "./types.js";

/** 只读取纯文本类文件,二进制文件一律跳过,避免把垃圾塞进知识库。 */
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".text",
  ".json",
  ".yml",
  ".yaml",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".xml",
  ".log",
  ".rst",
  ".adoc",
]);

/**
 * 本地目录连接器:递归读取目录下的文本文件。
 *
 * `baseUrl` 是本地绝对或相对路径;文件系统通过 `deps.fs` 注入,单测无需真实磁盘。
 * 外部 id 取相对路径(POSIX 分隔符),对文件重命名敏感,但跨同步稳定。
 */
export const localDirConnector: Connector = {
  type: "local-dir",
  async fetchDocuments(config: ConnectorConfig, deps: ConnectorDeps): Promise<ConnectorDocument[]> {
    if (!config.baseUrl) throw new Error("local-dir connector requires baseUrl (directory path)");
    const fs = requireFs(deps);
    const root = config.baseUrl;
    const files: string[] = [];
    await walk(fs, root, files);
    files.sort();
    const documents: ConnectorDocument[] = [];
    for (const file of files) {
      const content = await fs.readFile(file);
      const relativePath = relative(root, file).split(sep).join("/");
      const extension = extname(file).toLowerCase();
      documents.push({
        externalId: relativePath,
        title: basename(file, extension) || relativePath,
        content,
        url: null,
        mimeType: mimeTypeForExtension(extension),
        updatedAt: null,
      });
    }
    return documents;
  },
};

function requireFs(deps: ConnectorDeps): ConnectorFileSystem {
  if (!deps.fs) throw new Error("local-dir connector requires an fs implementation");
  return deps.fs;
}

async function walk(fs: ConnectorFileSystem, dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fs, path, out);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(path);
    }
  }
}

function mimeTypeForExtension(extension: string): string {
  if (extension === ".json") return "application/json";
  if (extension === ".csv" || extension === ".tsv") return "text/csv";
  if (extension === ".html" || extension === ".htm") return "text/html";
  if (extension === ".xml") return "application/xml";
  if (extension === ".yml" || extension === ".yaml") return "text/yaml";
  return "text/markdown";
}
