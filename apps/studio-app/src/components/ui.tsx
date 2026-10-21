import React from "react";
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  ActivityIndicator,
  Banner,
  Button,
  Card as PaperCard,
  Checkbox,
  Chip,
  Divider,
  IconButton,
  TextInput,
  useTheme,
} from "react-native-paper";
import { lightTheme } from "../theme";

/** Compatibility tokens retained for the screen layer. Components read the live MD3 theme. */
export const colors = {
  bg: lightTheme.colors.background,
  card: lightTheme.colors.surface,
  border: lightTheme.colors.outlineVariant,
  text: lightTheme.colors.onSurface,
  sub: lightTheme.colors.onSurfaceVariant,
  primary: lightTheme.colors.primary,
  accent: lightTheme.colors.secondary,
  danger: lightTheme.colors.error,
  ok: "#15665a",
  warn: "#9a5318",
};

export function Screen({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: theme.colors.background }, style]}>
      {children}
    </View>
  );
}
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <PaperCard mode="outlined" style={[styles.card, style]}>
      <PaperCard.Content>{children}</PaperCard.Content>
    </PaperCard>
  );
}
export function Title({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <Text style={[styles.title, { color: theme.colors.onBackground }]} accessibilityRole="header">
      {children}
    </Text>
  );
}
export function Sub({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return <Text style={[styles.sub, { color: theme.colors.onSurfaceVariant }]}>{children}</Text>;
}
export function Btn({
  title,
  onPress,
  kind = "primary",
  disabled,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "ghost" | "danger";
  disabled?: boolean;
}) {
  const theme = useTheme();
  const mode = kind === "ghost" ? "outlined" : "contained";
  return (
    <Button
      mode={mode}
      compact
      onPress={onPress}
      disabled={disabled}
      buttonColor={kind === "danger" ? theme.colors.error : undefined}
      textColor={
        kind === "danger"
          ? theme.colors.onError
          : kind === "ghost"
            ? theme.colors.primary
            : undefined
      }
      style={styles.btn}
      contentStyle={styles.btnContent}
    >
      {title}
    </Button>
  );
}
export function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
  secret,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  secret?: boolean;
  hint?: string;
}) {
  return (
    <View style={styles.field}>
      <TextInput
        mode="outlined"
        label={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        multiline={multiline}
        secureTextEntry={secret}
        numberOfLines={multiline ? 4 : undefined}
        style={[styles.input, multiline && styles.inputMulti]}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}
export function ErrorText({ message, onRetry }: { message: string | null; onRetry?: () => void }) {
  if (!message) return null;
  return (
    <Banner
      visible
      icon="alert-circle-outline"
      actions={onRetry ? [{ label: "重试", onPress: onRetry }] : []}
      style={styles.errorBanner}
    >
      {message}
    </Banner>
  );
}
export function Loading({ label = "加载中…" }: { label?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="small" color={theme.colors.primary} />
      <Text style={[styles.sub, { color: theme.colors.onSurfaceVariant }]}>{label}</Text>
    </View>
  );
}
export function List({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
      {children}
    </ScrollView>
  );
}

/** 底部弹出式抽屉（对齐 Web Drawer）：全屏 Modal + 底部 sheet 样式。 */
export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= 720;
  return (
    <Modal visible={visible} animationType={wide ? "fade" : "slide"} transparent onRequestClose={onClose}>
      <View style={[styles.sheetBackdrop, wide && styles.sheetBackdropWide]}>
        <View
          style={[
            styles.sheet,
            wide && styles.sheetWide,
            { backgroundColor: theme.colors.surface },
          ]}
        >
          <View style={[styles.sheetHeader, { borderBottomColor: theme.colors.outlineVariant }]}>
            <Text style={[styles.sheetTitle, { color: theme.colors.onSurface }]}>{title}</Text>
            <IconButton icon="close" accessibilityLabel="关闭" onPress={onClose} />
          </View>
          <ScrollView
            contentContainerStyle={styles.sheetBody}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** 复选行（对齐 Web resource-check-row）：勾选框 + 标题 + 描述。 */
export function CheckRow({
  checked,
  title,
  desc,
  missing,
  disabled,
  onToggle,
}: {
  checked: boolean;
  title: string;
  desc?: string;
  missing?: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.checkRow,
        { borderBottomColor: theme.colors.outlineVariant },
        missing && { backgroundColor: theme.colors.secondaryContainer },
        disabled && styles.checkRowDisabled,
      ]}
    >
      <Checkbox
        status={checked ? "checked" : "unchecked"}
        disabled={disabled}
        onPress={() => onToggle(!checked)}
      />
      <View style={{ flex: 1 }}>
        <Text style={[styles.checkTitle, { color: theme.colors.onSurface }]} numberOfLines={1}>
          {title}
          {missing ? "（已失效）" : ""}
        </Text>
        {desc ? (
          <Text
            style={[styles.checkDesc, { color: theme.colors.onSurfaceVariant }]}
            numberOfLines={2}
          >
            {desc}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** 横向选项条（Provider/格式/渠道等多选用）。 */
export function OptionBar<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  labels?: Record<string, string>;
}) {
  const theme = useTheme();
  return (
    <View style={styles.optionBar}>
      {options.map((o) => (
        <Chip
          key={o}
          compact
          mode="outlined"
          selected={value === o}
          showSelectedCheck={false}
          onPress={() => onChange(o)}
          style={[
            styles.optionChip,
            value === o && {
              backgroundColor: theme.colors.secondaryContainer,
              borderColor: theme.colors.secondaryContainer,
            },
          ]}
        >
          {labels?.[o] ?? o}
        </Chip>
      ))}
    </View>
  );
}

/** 步进器（Top-K / 阈值等数字配置，替代 Web Slider）。 */
export function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.stepper}>
      <IconButton
        mode="outlined"
        icon="minus"
        accessibilityLabel="减少"
        onPress={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
      />
      <Text style={[styles.stepValue, { color: theme.colors.onSurface }]}>{value}</Text>
      <IconButton
        mode="outlined"
        icon="plus"
        accessibilityLabel="增加"
        onPress={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
      />
    </View>
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>{title}</Text>
        {description ? (
          <Text style={[styles.sectionDescription, { color: theme.colors.onSurfaceVariant }]}>
            {description}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  );
}

export function DividerLine() {
  return <Divider style={styles.divider} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
  card: {
    marginBottom: 14,
    borderRadius: 16,
  },
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.6, marginBottom: 6 },
  sub: { fontSize: 13, lineHeight: 19, marginBottom: 6 },
  btn: {
    borderRadius: 10,
    marginVertical: 3,
    marginRight: 6,
  },
  btnContent: { minHeight: 40 },
  field: { marginBottom: 12 },
  input: {
    backgroundColor: "transparent",
    fontSize: 14,
  },
  inputMulti: { minHeight: 104, textAlignVertical: "top" },
  hint: { fontSize: 12, color: colors.sub, marginTop: 5, marginHorizontal: 4 },
  errorBanner: { marginBottom: 12, borderRadius: 12 },
  loading: { padding: 24, alignItems: "center", gap: 8 },
  list: { flex: 1 },
  listContent: { paddingBottom: 40 },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(10, 16, 14, 0.52)",
    justifyContent: "flex-end",
  },
  sheetBackdropWide: { alignItems: "center", justifyContent: "center", padding: 24 },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: "88%",
  },
  sheetWide: { borderRadius: 24, maxWidth: 720, width: "100%", maxHeight: "84%" },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  sheetTitle: { fontSize: 20, fontWeight: "700" },
  sheetBody: { padding: 20, paddingBottom: 36 },
  checkRow: {
    flexDirection: "row",
    gap: 4,
    alignItems: "center",
    paddingVertical: 4,
    borderBottomWidth: 1,
  },
  checkRowDisabled: { opacity: 0.5 },
  checkTitle: { fontWeight: "600", fontSize: 14 },
  checkDesc: { fontSize: 12, marginTop: 2 },
  optionBar: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 10 },
  optionChip: { marginBottom: 2 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6, marginVertical: 2 },
  stepValue: {
    fontSize: 16,
    fontWeight: "700",
    minWidth: 36,
    textAlign: "center",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 4,
    marginBottom: 10,
  },
  sectionTitle: { fontSize: 16, fontWeight: "700" },
  sectionDescription: { fontSize: 12, marginTop: 2, lineHeight: 17 },
  divider: { marginVertical: 12 },
});
