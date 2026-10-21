import React from "react";
import { StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { Screen } from "./ui";

/**
 * Shared page frame for the nine workspaces.
 * Keeps a readable content width on tablets while preserving native edge padding on phones.
 */
export function WorkspaceScreen({
  children,
  eyebrow,
  title,
  description,
}: {
  children: React.ReactNode;
  eyebrow?: string;
  title: string;
  description: string;
}) {
  const theme = useTheme();
  return (
    <Screen>
      <View style={styles.content}>
        <View style={styles.inner}>
          <Text
            variant="labelMedium"
            style={[styles.eyebrow, { color: theme.colors.secondary }]}
          >
            {eyebrow ?? "OPEN AGENT STUDIO"}
          </Text>
          <Text
            variant="headlineLarge"
            accessibilityRole="header"
            style={[styles.title, { color: theme.colors.onBackground }]}
          >
            {title}
          </Text>
          <Text
            variant="bodyMedium"
            style={[styles.description, { color: theme.colors.onSurfaceVariant }]}
          >
            {description}
          </Text>
          <View style={styles.body}>{children}</View>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    paddingBottom: 48,
    alignItems: "center",
  },
  inner: {
    width: "100%",
    maxWidth: 920,
  },
  eyebrow: {
    letterSpacing: 1.6,
    fontWeight: "700",
    marginTop: 8,
    marginBottom: 8,
  },
  title: {
    fontSize: 34,
    lineHeight: 40,
    fontWeight: "700",
    letterSpacing: -0.8,
  },
  description: {
    marginTop: 8,
    marginBottom: 22,
    lineHeight: 21,
    maxWidth: 680,
  },
  body: {
    width: "100%",
  },
});
