import { useEffect, useState } from "react";
import { ReloadOutlined, SaveOutlined } from "../../lib/icons.js";
import {
  DEFAULT_BRANDING,
  fetchBranding,
  resetBranding,
  saveBranding,
  type BrandingConfig,
} from "./api.js";
import { applyBranding } from "./applyBranding.js";

type Notice = { type: "error" | "success"; text: string } | null;

/**
 * 白标配置:改产品名/标记/配色/页脚与渠道码,保存后立即应用到当前 Studio。
 * 字段全部是展示信息,不含任何密钥,因此和业务配置分开放。
 */
export function BrandingSection() {
  const [branding, setBranding] = useState<BrandingConfig>(DEFAULT_BRANDING);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = async () => {
    setLoading(true);
    try {
      const value = await fetchBranding();
      setBranding(value);
      setNotice(null);
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const update = <K extends keyof BrandingConfig>(key: K, value: BrandingConfig[K]) => {
    setBranding((current) => ({ ...current, [key]: value }));
  };

  const submit = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const saved = await saveBranding(branding);
      setBranding(saved);
      applyBranding(saved);
      setNotice({ type: "success", text: "品牌配置已保存并应用到当前界面" });
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const restored = await resetBranding();
      setBranding(restored);
      applyBranding(restored);
      setNotice({ type: "success", text: "已恢复默认品牌" });
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="settings-content">
      {notice ? (
        <div className={`settings-alert${notice.type === "success" ? " is-success" : ""}`}>
          {notice.text}
        </div>
      ) : null}
      <div className="settings-intro">
        <div>
          <span className="settings-kicker">WHITE LABEL</span>
          <h2>
            <SaveOutlined /> 品牌与渠道
          </h2>
        </div>
        <div className="domain-header-actions">
          <button
            className="studio-button secondary"
            type="button"
            onClick={() => void load()}
            disabled={loading || saving}
          >
            <ReloadOutlined spin={loading} /> <span>重新读取</span>
          </button>
          <button
            className="studio-button secondary"
            type="button"
            onClick={() => void reset()}
            disabled={saving}
          >
            <span>恢复默认</span>
          </button>
          <button
            className="studio-button primary"
            type="button"
            onClick={() => void submit()}
            disabled={saving}
          >
            <SaveOutlined /> <span>{saving ? "保存中..." : "保存品牌"}</span>
          </button>
        </div>
      </div>

      <div className="branding-preview">
        <span
          className="branding-preview__mark"
          style={{
            background: branding.primaryColor,
          }}
        >
          {branding.logoUrl ? <img src={branding.logoUrl} alt="" /> : branding.markText}
        </span>
        <div>
          <b>{branding.productName}</b>
          <small>
            {branding.shortName}
            {branding.partnerCode ? ` · 渠道 ${branding.partnerCode}` : ""}
          </small>
        </div>
        <span className="branding-preview__swatches">
          <i style={{ background: branding.primaryColor }} title={branding.primaryColor} />
          <i style={{ background: branding.accentColor }} title={branding.accentColor} />
        </span>
      </div>

      <div className="settings-modal-fields">
        <label className="studio-field">
          <span>产品名</span>
          <input
            value={branding.productName}
            maxLength={60}
            onChange={(event) => update("productName", event.target.value)}
            placeholder="例如:某某智能助手"
          />
        </label>
        <label className="studio-field">
          <span>简称</span>
          <input
            value={branding.shortName}
            maxLength={16}
            onChange={(event) => update("shortName", event.target.value)}
            placeholder="用于空间与页脚"
          />
        </label>
        <label className="studio-field">
          <span>图标文字(最多 4 字)</span>
          <input
            value={branding.markText}
            maxLength={4}
            onChange={(event) => update("markText", event.target.value)}
            placeholder="OA"
          />
        </label>
        <label className="studio-field">
          <span>Logo 地址(可选,优先于图标文字)</span>
          <input
            value={branding.logoUrl ?? ""}
            onChange={(event) => update("logoUrl", event.target.value || null)}
            placeholder="https://.../logo.svg"
          />
        </label>
        <label className="studio-field">
          <span>主色</span>
          <span className="branding-color">
            <input
              type="color"
              value={branding.primaryColor}
              onChange={(event) => update("primaryColor", event.target.value)}
            />
            <code>{branding.primaryColor}</code>
          </span>
        </label>
        <label className="studio-field">
          <span>辅色</span>
          <span className="branding-color">
            <input
              type="color"
              value={branding.accentColor}
              onChange={(event) => update("accentColor", event.target.value)}
            />
            <code>{branding.accentColor}</code>
          </span>
        </label>
        <label className="studio-field">
          <span>支持链接(可选)</span>
          <input
            value={branding.supportUrl ?? ""}
            onChange={(event) => update("supportUrl", event.target.value || null)}
            placeholder="https://help.example.com"
          />
        </label>
        <label className="studio-field">
          <span>页脚文案(可选)</span>
          <input
            value={branding.footerText}
            maxLength={120}
            onChange={(event) => update("footerText", event.target.value)}
            placeholder="例如:某某科技提供技术支持"
          />
        </label>
        <label className="studio-field">
          <span>渠道分销码(可选)</span>
          <input
            value={branding.partnerCode ?? ""}
            maxLength={32}
            onChange={(event) => update("partnerCode", event.target.value || null)}
            placeholder="例如:partner-east"
          />
        </label>
        <label className="studio-field studio-field--inline">
          <input
            type="checkbox"
            checked={branding.hideVendorBrand}
            onChange={(event) => update("hideVendorBrand", event.target.checked)}
          />
          <span>隐藏原厂品牌字样</span>
        </label>
      </div>

      <p className="mcp-gateway-note">
        品牌配置只影响展示,不改变鉴权、配额与数据权限。渠道分销码会写入公开品牌信息,便于按安装实例统计归属。
      </p>
    </main>
  );
}
