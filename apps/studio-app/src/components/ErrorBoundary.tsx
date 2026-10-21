import React from "react";
import { StyleSheet, View } from "react-native";
import { Button, Surface, Text } from "react-native-paper";

interface State {
  error: Error | null;
}

/**
 * Keeps a single workspace failure from blanking the whole studio shell.
 * The boundary is remounted when the active workspace changes.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; resetKey?: string },
  State
> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(prevProps: { resetKey?: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.wrap}>
        <Surface elevation={0} style={styles.card}>
          <Text variant="headlineSmall" style={styles.title}>
            这个工作区暂时无法显示
          </Text>
          <Text variant="bodyMedium" style={styles.copy}>
            {this.state.error.message || "页面渲染发生未知错误"}
          </Text>
          <Button mode="contained" onPress={() => this.setState({ error: null })}>
            重新加载
          </Button>
        </Surface>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 24, justifyContent: "center" },
  card: { borderRadius: 20, padding: 24, alignSelf: "center", maxWidth: 560, width: "100%" },
  title: { fontWeight: "700", marginBottom: 8 },
  copy: { marginBottom: 18, opacity: 0.72 },
});
