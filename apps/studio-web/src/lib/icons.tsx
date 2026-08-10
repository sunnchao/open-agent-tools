/**
 * Lucide 图标统一桥接层。
 *
 * 将原有 @ant-design/icons 的图标名称映射为 Lucide 图标，
 * 保持组件签名兼容（className / style / spin / rotate），
 * 便于在不动业务代码的前提下全局统一图标体系。
 */
import { createElement } from "react";
import type { CSSProperties, FC } from "react";
import type { LucideProps } from "lucide-react";
import {
  ArrowDown,
  Webhook,
  Boxes,
  Building2,
  Check,
  CheckCircle2,
  CirclePause,
  CirclePlay,
  CloudUpload,
  Code,
  Copy,
  Database,
  Download,
  Eye,
  FileSearch,
  FileText,
  Flag,
  FlaskConical,
  GitBranch,
  Hammer,
  KeyRound,
  Loader2,
  MessageSquare,
  Minus,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
  Plus,
  RefreshCcw,
  RefreshCw,
  Rocket,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SquarePen,
  Star,
  Trash2,
  Undo2,
  Upload,
  User,
  Users,
  Wrench,
  X,
  XCircle,
  Zap,
} from "lucide-react";

type IconComponent = FC<LucideProps>;

interface AdapterProps {
  className?: string;
  style?: CSSProperties;
  spin?: boolean | { rotate?: number };
  rotate?: number;
  [key: string]: unknown;
}

/** 将 Lucide 图标包装为兼容 antd 图标调用方式的适配器组件。 */
function adapt(Icon: IconComponent, filled = false): FC<AdapterProps> {
  const Wrapped: FC<AdapterProps> = ({ className, style, spin, rotate, ...rest }) => {
    const fontSize = typeof style?.fontSize === "number" ? style.fontSize : undefined;
    const mergedProps: LucideProps & Record<string, unknown> = {
      className: ["studio-icon", className, spin ? "lucide-spin" : undefined]
        .filter(Boolean)
        .join(" "),
      style: fontSize ? { ...style, fontSize: undefined } : style,
      size: fontSize ?? 16,
      strokeWidth: filled ? 1.6 : 1.9,
      ...(filled ? { fill: "currentColor" } : {}),
      ...(rotate ? { transform: `rotate(${rotate}deg)` } : {}),
      ...rest,
    };
    return createElement(Icon, mergedProps);
  };
  return Wrapped;
}

// ── 基础操作 ──
export const PlusOutlined = adapt(Plus);
export const MinusOutlined = adapt(Minus);
export const CheckOutlined = adapt(Check);
export const CloseOutlined = adapt(X);
export const CopyOutlined = adapt(Copy);
export const DeleteOutlined = adapt(Trash2);
export const EditOutlined = adapt(SquarePen);
export const SearchOutlined = adapt(Search);
export const SaveOutlined = adapt(Save);
export const DownloadOutlined = adapt(Download);
export const UploadOutlined = adapt(Upload);
export const ReloadOutlined = adapt(RefreshCw);
export const SyncOutlined = adapt(RefreshCcw);
export const UndoOutlined = adapt(Undo2);
export const SendOutlined = adapt(Send);
export const EyeOutlined = adapt(Eye);
export const SettingOutlined = adapt(Settings);
export const StarOutlined = adapt(Star);
export const ArrowDownOutlined = adapt(ArrowDown);
export const PanelLeftCloseOutlined = adapt(PanelLeftClose);
export const PanelLeftOpenOutlined = adapt(PanelLeftOpen);

// ── 领域 / 业务 ──
export const ApiOutlined = adapt(Webhook);
export const ApartmentOutlined = adapt(Boxes);
export const BranchesOutlined = adapt(GitBranch);
export const MessageOutlined = adapt(MessageSquare);
export const DatabaseOutlined = adapt(Database);
export const NodeIndexOutlined = adapt(Network);
export const ExperimentOutlined = adapt(FlaskConical);
export const FlagOutlined = adapt(Flag);
export const UserOutlined = adapt(User);
export const TeamOutlined = adapt(Users);
export const ThunderboltOutlined = adapt(Zap);
export const ToolOutlined = adapt(Wrench);
export const FileTextOutlined = adapt(FileText);
export const CloudUploadOutlined = adapt(CloudUpload);
export const RocketOutlined = adapt(Rocket);
export const KeyOutlined = adapt(KeyRound);
export const SafetyCertificateOutlined = adapt(ShieldCheck);
export const AuditOutlined = adapt(FileSearch);
export const CodeOutlined = adapt(Code);
export const BuildOutlined = adapt(Hammer);
export const Building2Outlined = adapt(Building2);
export const PauseCircleOutlined = adapt(CirclePause);
export const PlayCircleOutlined = adapt(CirclePlay);
export const PlayCircleFilled = adapt(CirclePlay, true);
export const CheckCircleFilled = adapt(CheckCircle2, true);
export const CloseCircleFilled = adapt(XCircle, true);
export const PencilOutlined = adapt(PencilLine);

/** 始终旋转的加载图标 */
export const LoadingOutlined = adapt(Loader2, false);
LoadingOutlined.displayName = "LoadingOutlined";
