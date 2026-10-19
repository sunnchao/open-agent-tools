import { httpConnector } from "./httpConnector.js";
import { localDirConnector } from "./localDirConnector.js";
import { confluenceConnector, feishuConnector, yuqueConnector } from "./providers.js";
import { type Connector, type ConnectorType } from "./types.js";

const REGISTRY: Record<ConnectorType, Connector> = {
  http: httpConnector,
  "local-dir": localDirConnector,
  feishu: feishuConnector,
  yuque: yuqueConnector,
  confluence: confluenceConnector,
};

/** 按类型取连接器实现;类型非法时抛错,由调用方翻译成 400/500。 */
export function connectorFor(type: ConnectorType): Connector {
  const connector = REGISTRY[type];
  if (!connector) throw new Error(`unsupported connector type: ${String(type)}`);
  return connector;
}
