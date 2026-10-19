export const port = Number(process.env.PORT) || 3000;
export const webOrigin = process.env.WEB_ORIGIN || "http://localhost:5173";
/** 主服务部署 token：用于 Studio 管理与运行接口的最小鉴权；缺省保持本地体验。 */
export const studioApiToken =
  process.env.STUDIO_API_TOKEN?.trim() || process.env.SERVER_API_TOKEN?.trim() || "";
export const studioAuthEnabled = studioApiToken.length > 0;
