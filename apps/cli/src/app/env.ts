import dotenv from "dotenv";

/** 按约定顺序加载环境变量（后加载的可覆盖先前的本地覆盖项）。 */
export function loadEnv(): void {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.local" });
  dotenv.config({ path: `.env.${process.env.NODE_ENV || "development"}` });
  dotenv.config({ path: `.env.${process.env.NODE_ENV || "development"}.local` });
}
