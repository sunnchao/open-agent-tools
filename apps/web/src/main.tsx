import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import { App } from "./App.js";
import "./styles/global.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <ConfigProvider>
      <AntApp style={{ height: "100%" }}>
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
