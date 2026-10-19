import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App as AntApp, ConfigProvider, theme } from "antd";
import { App } from "./App.js";
import { EmployeeApp } from "./features/apps/EmployeeApp.js";
import { applyBranding } from "./features/branding/applyBranding.js";
import {
  DEFAULT_BRANDING,
  fetchPublicBranding,
  type BrandingConfig,
} from "./features/branding/api.js";
import "./styles/global.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

/**
 * 员工侧入口:`#/app/<slug>` 走独立的问答页面,不加载 Studio 管理台。
 * 这样发布出去的是一个产品,而不是「把管理后台给员工看」。
 */
function employeeSlug(): string | null {
  const match = window.location.hash.match(/^#\/?app\/([a-z0-9-]+)$/i);
  return match?.[1] ?? null;
}

const slug = employeeSlug();

/**
 * 白标根节点:启动时读取公开品牌配置,读不到就回落到默认品牌,
 * 保证网络或后端异常时界面照常渲染,只是回到默认外观。
 */
function StudioRoot() {
  const [branding, setBranding] = useState<BrandingConfig>(DEFAULT_BRANDING);

  useEffect(() => {
    applyBranding(branding, { documentTitleSuffix: slug ? "Knowledge" : "Studio" });
  }, [branding]);

  useEffect(() => {
    let cancelled = false;
    fetchPublicBranding()
      .then((value) => {
        if (!cancelled) setBranding(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: branding.primaryColor,
          colorInfo: branding.accentColor,
          colorSuccess: "#2f9e6e",
          colorWarning: "#d98a2b",
          colorError: "#d64545",
          colorTextBase: "#1d2024",
          colorBgBase: "#f6f5f1",
          colorBgContainer: "#ffffff",
          colorBgElevated: "#ffffff",
          colorBgLayout: "#f0efea",
          colorBorder: "#dfddd6",
          colorBorderSecondary: "#e8e6df",
          colorTextSecondary: "#6b7077",
          colorTextTertiary: "#9a9ea5",
          borderRadius: 8,
          fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
          fontSize: 14,
        },
        components: {
          Button: {
            controlHeight: 32,
            fontWeight: 600,
          },
          Input: {
            controlHeight: 32,
          },
          Select: {
            controlHeight: 32,
          },
          Drawer: {
            colorBgElevated: "#ffffff",
          },
          Popconfirm: {
            colorBgElevated: "#ffffff",
          },
          Tooltip: {
            colorBgSpotlight: "#23272c",
          },
        },
      }}
    >
      <AntApp style={{ height: "100%" }}>
        {slug ? null : <div className="studio-grain" aria-hidden="true" />}
        {slug ? <EmployeeApp slug={slug} /> : <App branding={branding} />}
      </AntApp>
    </ConfigProvider>
  );
}

createRoot(rootEl).render(
  <StrictMode>
    <StudioRoot />
  </StrictMode>,
);
