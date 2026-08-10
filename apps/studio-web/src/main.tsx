import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App as AntApp, ConfigProvider, theme } from "antd";
import { App } from "./App.js";
import "./styles/global.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#8fb22e",
          colorInfo: "#3d7dcc",
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
          fontFamily:
            '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
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
        <div className="studio-grain" aria-hidden="true" />
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
