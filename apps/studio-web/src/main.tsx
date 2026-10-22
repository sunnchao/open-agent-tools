import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App as AntApp, ConfigProvider, theme } from "antd";
import "./styles/global.css";
import { App } from "./App.js";
import { EmployeeApp } from "./features/apps/EmployeeApp.js";
import { applyBranding } from "./features/branding/applyBranding.js";
import {
  DEFAULT_BRANDING,
  fetchPublicBranding,
  type BrandingConfig,
} from "./features/branding/api.js";

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
          colorPrimary: "#0f513f",
          colorInfo: "#0b6e63",
          colorSuccess: "#0b6e63",
          colorWarning: "#9a5a09",
          colorError: "#a92d24",
          colorTextBase: "#111a15",
          colorBgBase: "#eef1ee",
          colorBgContainer: "#ffffff",
          colorBgElevated: "#ffffff",
          colorBgLayout: "#eef1ee",
          colorBorder: "#c8d2cb",
          colorBorderSecondary: "#dde4df",
          colorTextSecondary: "#5b6861",
          colorTextTertiary: "#68756d",
          borderRadius: 8,
          fontFamily:
            '"Instrument Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
          fontSize: 13,
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
          Card: {
            bodyPadding: 16,
            headerPadding: 16,
          },
          Table: {
            headerBg: "#f6f8f6",
          },
          Tabs: {
            inkBarColor: "#0f513f",
          },
          Segmented: {
            trackBg: "#edf1ee",
          },
          Alert: {},
          Modal: {},
          Empty: {},
          Tag: {},
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
