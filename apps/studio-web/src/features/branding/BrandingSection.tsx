import { useEffect, useState } from "react";
import { Alert, App, Button, Card, Checkbox, Flex, Form, Input, Typography } from "antd";
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
  const { message } = App.useApp();
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
      const text = reason instanceof Error ? reason.message : String(reason);
      setNotice({ type: "error", text });
      void message.error(text);
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
      void message.success("品牌配置已保存并应用到当前界面");
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : String(reason);
      setNotice({ type: "error", text });
      void message.error(text);
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
      void message.success("已恢复默认品牌");
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : String(reason);
      setNotice({ type: "error", text });
      void message.error(text);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Flex vertical gap={12}>
      {notice ? (
        <Alert
          type={notice.type}
          showIcon
          message={notice.text}
          closable
          onClose={() => setNotice(null)}
        />
      ) : null}
      <Flex align="flex-start" justify="space-between" gap={12} wrap>
        <Flex vertical gap={2}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2 }}
          >
            WHITE LABEL
          </Typography.Text>
          <Typography.Title level={5} style={{ margin: 0 }}>
            品牌与渠道
          </Typography.Title>
        </Flex>
        <Flex gap={8} wrap>
          <Button
            icon={<ReloadOutlined spin={loading} />}
            onClick={() => void load()}
            disabled={loading || saving}
          >
            重新读取
          </Button>
          <Button onClick={() => void reset()} disabled={saving}>
            恢复默认
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={() => void submit()}
            loading={saving}
            disabled={saving}
          >
            {saving ? "保存中..." : "保存品牌"}
          </Button>
        </Flex>
      </Flex>

      <Card size="small" title="预览">
        <Flex align="center" gap={12}>
          <Flex
            align="center"
            justify="center"
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: branding.primaryColor,
              overflow: "hidden",
              flex: "0 0 auto",
            }}
          >
            {branding.logoUrl ? (
              <img
                src={branding.logoUrl}
                alt="品牌 Logo"
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              <Typography.Text strong style={{ color: "#fff" }}>
                {branding.markText}
              </Typography.Text>
            )}
          </Flex>
          <Flex vertical gap={0} style={{ minWidth: 0, flex: 1 }}>
            <Typography.Text strong ellipsis>
              {branding.productName}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {branding.shortName}
              {branding.partnerCode ? ` · 渠道 ${branding.partnerCode}` : ""}
            </Typography.Text>
          </Flex>
          <Flex gap={4} align="center">
            <span
              title={branding.primaryColor}
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                background: branding.primaryColor,
                display: "inline-block",
              }}
            />
            <span
              title={branding.accentColor}
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                background: branding.accentColor,
                display: "inline-block",
              }}
            />
          </Flex>
        </Flex>
      </Card>

      <Form layout="vertical">
        <Form.Item label="产品名">
          <Input
            aria-label="产品名"
            value={branding.productName}
            maxLength={60}
            onChange={(event) => update("productName", event.target.value)}
            placeholder="例如:某某智能助手"
          />
        </Form.Item>
        <Form.Item label="简称">
          <Input
            aria-label="简称"
            value={branding.shortName}
            maxLength={16}
            onChange={(event) => update("shortName", event.target.value)}
            placeholder="用于空间与页脚"
          />
        </Form.Item>
        <Form.Item label="图标文字(最多 4 字)">
          <Input
            aria-label="图标文字"
            value={branding.markText}
            maxLength={4}
            onChange={(event) => update("markText", event.target.value)}
            placeholder="OA"
          />
        </Form.Item>
        <Form.Item label="Logo 地址(可选,优先于图标文字)">
          <Input
            aria-label="Logo 地址"
            value={branding.logoUrl ?? ""}
            onChange={(event) => update("logoUrl", event.target.value || null)}
            placeholder="https://.../logo.svg"
          />
        </Form.Item>
        <Form.Item label="主色">
          <Flex align="center" gap={8}>
            {/* 例外:原生取色器,AntD 无等价 ColorPicker 轻量替代,保留 input[type=color] 仅做取色 */}
            <input
              type="color"
              aria-label="主色"
              value={branding.primaryColor}
              onChange={(event) => update("primaryColor", event.target.value)}
            />
            <Typography.Text code>{branding.primaryColor}</Typography.Text>
          </Flex>
        </Form.Item>
        <Form.Item label="辅色">
          <Flex align="center" gap={8}>
            {/* 例外:原生取色器,AntD 无等价 ColorPicker 轻量替代,保留 input[type=color] 仅做取色 */}
            <input
              type="color"
              aria-label="辅色"
              value={branding.accentColor}
              onChange={(event) => update("accentColor", event.target.value)}
            />
            <Typography.Text code>{branding.accentColor}</Typography.Text>
          </Flex>
        </Form.Item>
        <Form.Item label="支持链接(可选)">
          <Input
            aria-label="支持链接"
            value={branding.supportUrl ?? ""}
            onChange={(event) => update("supportUrl", event.target.value || null)}
            placeholder="https://help.example.com"
          />
        </Form.Item>
        <Form.Item label="页脚文案(可选)">
          <Input
            aria-label="页脚文案"
            value={branding.footerText}
            maxLength={120}
            onChange={(event) => update("footerText", event.target.value)}
            placeholder="例如:某某科技提供技术支持"
          />
        </Form.Item>
        <Form.Item label="渠道分销码(可选)">
          <Input
            aria-label="渠道分销码"
            value={branding.partnerCode ?? ""}
            maxLength={32}
            onChange={(event) => update("partnerCode", event.target.value || null)}
            placeholder="例如:partner-east"
          />
        </Form.Item>
        <Form.Item>
          <Checkbox
            checked={branding.hideVendorBrand}
            onChange={(event) => update("hideVendorBrand", event.target.checked)}
          >
            隐藏原厂品牌字样
          </Checkbox>
        </Form.Item>
      </Form>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        品牌配置只影响展示,不改变鉴权、配额与数据权限。渠道分销码会写入公开品牌信息,便于按安装实例统计归属。
      </Typography.Paragraph>
    </Flex>
  );
}
