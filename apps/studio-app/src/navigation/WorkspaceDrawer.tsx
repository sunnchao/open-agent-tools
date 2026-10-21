import React, { useEffect, useRef } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Icon, Text, useTheme } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { WORKSPACES, WORKSPACE_COPY, type WorkspaceTab } from "../lib/types";
import { workspaceIcons } from "../components/icons";

export function WorkspaceDrawer({
  visible,
  active,
  onSelect,
  onClose,
}: {
  visible: boolean;
  active: WorkspaceTab;
  onSelect: (tab: WorkspaceTab) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(slide, {
      toValue: visible ? 1 : 0,
      useNativeDriver: false,
      damping: 22,
      stiffness: 220,
    }).start();
  }, [visible, slide]);

  return (
    <View
      pointerEvents={visible ? "auto" : "none"}
      style={[StyleSheet.absoluteFill, styles.overlay, { zIndex: 100 }]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: slide }]}>
        <Pressable
          accessibilityLabel="关闭导航"
          onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.backdrop }]}
        />
      </Animated.View>
      <Animated.View
        style={[
          styles.panel,
          {
            width: Math.min(360, width * 0.88),
            backgroundColor: theme.colors.surface,
            borderRightColor: theme.colors.outlineVariant,
            transform: [
              {
                translateX: slide.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-Math.min(360, width * 0.88), 0],
                }),
              },
            ],
          },
        ]}
      >
        <View style={styles.brand}>
          <View style={[styles.logo, { backgroundColor: theme.colors.primary }]}>
            <MaterialCommunityIcons name="transit-connection-horizontal" size={23} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="titleLarge" style={styles.brandTitle}>
              Open Agent
            </Text>
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              STUDIO WORKSPACE
            </Text>
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.navList}>
          <Text
            variant="labelMedium"
            style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}
          >
            工作区
          </Text>
          {WORKSPACES.map((item) => {
            const copy = WORKSPACE_COPY[item.id];
            const selected = item.id === active;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => {
                  onSelect(item.id);
                  onClose();
                }}
                style={({ pressed }) => [
                  styles.navItem,
                  selected && { backgroundColor: theme.colors.secondaryContainer },
                  pressed && { opacity: 0.72 },
                ]}
              >
                <View
                  style={[
                    styles.navIcon,
                    {
                      backgroundColor: selected
                        ? theme.colors.secondary
                        : theme.colors.surfaceVariant,
                    },
                  ]}
                >
                  <MaterialCommunityIcons
                    name={workspaceIcons[item.id]}
                    size={21}
                    color={selected ? theme.colors.onSecondary : theme.colors.onSurfaceVariant}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text
                    variant="titleSmall"
                    style={{
                      color: selected ? theme.colors.onSecondaryContainer : theme.colors.onSurface,
                    }}
                  >
                    {copy.label}
                    <Text
                      variant="labelSmall"
                      style={{ color: theme.colors.onSurfaceVariant }}
                    >{`  ${copy.en}`}</Text>
                  </Text>
                  <Text
                    variant="bodySmall"
                    numberOfLines={1}
                    style={{ color: theme.colors.onSurfaceVariant }}
                  >
                    {copy.description}
                  </Text>
                </View>
                {selected ? (
                  <Icon source="arrow-right" size={18} color={theme.colors.secondary} />
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
        <View style={[styles.footer, { borderTopColor: theme.colors.outlineVariant }]}>
          <View style={[styles.statusDot, { backgroundColor: theme.colors.primary }]} />
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            本地工作台 · API 可配置
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { left: 0, right: 0, top: 0, bottom: 0 },
  panel: {
    height: "100%",
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 18,
  },
  logo: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  brandTitle: { fontWeight: "700", letterSpacing: -0.3 },
  navList: { paddingHorizontal: 12, paddingBottom: 24 },
  sectionLabel: { letterSpacing: 1.2, fontWeight: "700", paddingHorizontal: 12, marginBottom: 8 },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 10,
    borderRadius: 14,
    marginBottom: 3,
  },
  navIcon: {
    width: 38,
    height: 38,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: 1,
    paddingHorizontal: 22,
    paddingVertical: 16,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
});
