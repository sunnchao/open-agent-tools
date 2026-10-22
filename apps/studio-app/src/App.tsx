import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View, useColorScheme, useWindowDimensions } from "react-native";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import {
  Appbar,
  BottomNavigation,
  Icon,
  PaperProvider,
  Surface,
  Text,
  useTheme,
} from "react-native-paper";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { initialTab, normalizeTab } from "./navigation/tabs";
import { WORKSPACES, WORKSPACE_COPY, type WorkspaceTab } from "./lib/types";
import { WorkspaceDrawer } from "./navigation/WorkspaceDrawer";
import { workspaceIcons } from "./components/icons";
import { darkTheme, lightTheme, navigationDark, navigationLight } from "./theme";
import { loadThemePreference, type ThemePreference } from "./lib/themePreference";
import { ChatScreen } from "./screens/ChatScreen";
import { McpScreen } from "./screens/McpScreen";
import { RagScreen } from "./screens/RagScreen";
import { ConnectorsScreen } from "./screens/ConnectorsScreen";
import { ObservatoryScreen } from "./screens/ObservatoryScreen";
import { ReportsScreen } from "./screens/ReportsScreen";
import { WorkflowScreen } from "./screens/WorkflowScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ErrorBoundary } from "./components/ErrorBoundary";

const PRIMARY_TABS: WorkspaceTab[] = ["chat", "workflow", "observatory", "settings"];

function renderWorkspace(tab: WorkspaceTab) {
  switch (tab) {
    case "mcp":
      return <McpScreen />;
    case "rag":
      return <RagScreen />;
    case "connectors":
      return <ConnectorsScreen />;
    case "observatory":
      return <ObservatoryScreen />;
    case "reports":
      return <ReportsScreen />;
    case "workflow":
      return <WorkflowScreen />;
    case "settings":
      return <SettingsScreen />;
    case "chat":
      return null;
  }
}

function StudioShell({
  preference,
  onChangePreference,
}: {
  preference: ThemePreference;
  onChangePreference: (value: ThemePreference) => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const compact = width < 760;
  // 工作区无持久化；初始化时统一走 normalizeTab，兼容历史 "graph" 取值降级到知识库。
  const [tab, setTab] = useState<WorkspaceTab>(() => normalizeTab(initialTab()));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const contentRef = React.useRef<ScrollView>(null);
  const copy = WORKSPACE_COPY[tab];

  useEffect(() => {
    contentRef.current?.scrollTo({ y: 0, animated: false });
  }, [tab]);

  const primaryTabs = useMemo(() => {
    const current = WORKSPACES.find((item) => item.id === tab);
    const items = PRIMARY_TABS.map((id) => WORKSPACES.find((item) => item.id === id)!);
    return items.some((item) => item.id === tab) ? items : [current!, ...items.slice(1)];
  }, [tab]);

  const bottomRoutes = primaryTabs.map((item) => ({
    key: item.id,
    title: WORKSPACE_COPY[item.id].label,
    focusedIcon: workspaceIcons[item.id],
    unfocusedIcon: workspaceIcons[item.id],
  }));

  const themeToggle = () => {
    const next: ThemePreference =
      preference === "system" ? "light" : preference === "light" ? "dark" : "system";
    onChangePreference(next);
  };
  const themeLabel =
    preference === "system" ? "跟随系统" : preference === "light" ? "浅色" : "深色";

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: theme.colors.background,
          paddingTop: compact ? 0 : insets.top,
        },
      ]}
    >
      <StatusBar style={theme.dark ? "light" : "dark"} />
      <View style={styles.shell}>
        {!compact ? (
          <Surface
            elevation={0}
            style={[styles.rail, { borderRightColor: theme.colors.outlineVariant }]}
          >
            <View style={styles.railBrand}>
              <View style={[styles.railLogo, { backgroundColor: theme.colors.primary }]}>
                <MaterialCommunityIcons
                  name="transit-connection-horizontal"
                  size={24}
                  color="#fff"
                />
              </View>
              <View>
                <Text variant="titleMedium" style={styles.railTitle}>
                  Open Agent
                </Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  STUDIO
                </Text>
              </View>
            </View>
            <View style={styles.railNav}>
              {WORKSPACES.map((item) => {
                const selected = item.id === tab;
                return (
                  <Text
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setTab(item.id)}
                    variant="labelLarge"
                    style={[
                      styles.railItem,
                      selected && { backgroundColor: theme.colors.secondaryContainer },
                      {
                        color: selected
                          ? theme.colors.onSecondaryContainer
                          : theme.colors.onSurfaceVariant,
                      },
                    ]}
                  >
                    <MaterialCommunityIcons
                      name={workspaceIcons[item.id]}
                      size={22}
                      color={selected ? theme.colors.secondary : theme.colors.onSurfaceVariant}
                    />
                    <Text
                      variant="labelLarge"
                      style={{
                        color: selected
                          ? theme.colors.onSecondaryContainer
                          : theme.colors.onSurfaceVariant,
                      }}
                    >
                      {WORKSPACE_COPY[item.id].label}
                    </Text>
                  </Text>
                );
              })}
            </View>
            <View style={styles.railFoot}>
              <Icon source="circle" size={8} color={theme.colors.primary} />
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Local Studio
              </Text>
            </View>
          </Surface>
        ) : null}

        <View style={styles.main}>
          <Appbar.Header
            elevated={false}
            statusBarHeight={compact ? insets.top : 0}
            style={{ backgroundColor: theme.colors.background }}
          >
            {compact ? (
              <Appbar.Action
                icon="menu"
                accessibilityLabel="打开工作区导航"
                onPress={() => setDrawerOpen(true)}
              />
            ) : null}
            <Appbar.Content
              title={copy.label}
              titleStyle={styles.appbarTitle}
              subtitle={`${copy.en} · ${copy.description}`}
            />
            <Appbar.Action
              icon={
                preference === "dark"
                  ? "weather-night"
                  : preference === "light"
                    ? "white-balance-sunny"
                    : "theme-light-dark"
              }
              accessibilityLabel={`主题：${themeLabel}`}
              onPress={themeToggle}
            />
          </Appbar.Header>

          <ErrorBoundary resetKey={tab}>
            {tab === "chat" ? (
              <View key={tab} style={styles.workspace}>
                <ChatScreen />
              </View>
            ) : (
              <ScrollView
                ref={contentRef}
                key={tab}
                style={styles.workspace}
                contentContainerStyle={styles.workspaceContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {renderWorkspace(tab)}
              </ScrollView>
            )}
          </ErrorBoundary>

          {compact ? (
            <Surface
              elevation={3}
              style={[
                styles.bottomBar,
                {
                  paddingBottom: Math.max(insets.bottom, 6),
                  backgroundColor: theme.colors.surface,
                },
              ]}
            >
              <View style={styles.bottomBarClip}>
                <BottomNavigation.Bar
                  navigationState={{
                    index: Math.max(
                      0,
                      bottomRoutes.findIndex((route) => route.key === tab),
                    ),
                    routes: bottomRoutes,
                  }}
                  onTabPress={({ route }) => setTab(route.key as WorkspaceTab)}
                  style={{ backgroundColor: theme.colors.surface }}
                  activeIndicatorStyle={{ backgroundColor: theme.colors.secondaryContainer }}
                  getLabelText={({ route }) => route.title}
                  renderIcon={({ route, color, focused }) => (
                    <MaterialCommunityIcons
                      name={workspaceIcons[route.key as WorkspaceTab]}
                      color={color}
                      size={focused ? 25 : 23}
                    />
                  )}
                />
              </View>
            </Surface>
          ) : null}
        </View>
      </View>
      <WorkspaceDrawer
        visible={drawerOpen}
        active={tab}
        onSelect={setTab}
        onClose={() => setDrawerOpen(false)}
      />
    </View>
  );
}

export default function App() {
  const systemScheme = useColorScheme();
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    void loadThemePreference().then(setPreference);
  }, []);

  const dark = preference === "dark" || (preference === "system" && systemScheme === "dark");
  const paperTheme = dark ? darkTheme : lightTheme;
  const navigationTheme = dark ? navigationDark : navigationLight;

  return (
    <SafeAreaProvider>
      <PaperProvider theme={paperTheme}>
        <NavigationContainer theme={navigationTheme}>
          <StudioShell preference={preference} onChangePreference={setPreference} />
        </NavigationContainer>
      </PaperProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  shell: { flex: 1, flexDirection: "row" },
  rail: {
    width: 218,
    borderRightWidth: StyleSheet.hairlineWidth,
    paddingVertical: 22,
    paddingHorizontal: 12,
  },
  railBrand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 8,
    marginBottom: 30,
  },
  railLogo: {
    width: 42,
    height: 42,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  railTitle: { fontWeight: "700", letterSpacing: -0.2 },
  railNav: { flex: 1, gap: 2 },
  railItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 12,
  },
  railFoot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  main: { flex: 1, minWidth: 0 },
  appbarTitle: { fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
  workspace: { flex: 1, minHeight: 0 },
  workspaceContent: { flexGrow: 1 },
  bottomBar: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  bottomBarClip: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: "hidden",
  },
});
