import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";

export type PickedAsset = {
  name: string;
  size?: number;
  uri: string;
  mimeType?: string;
};

export type DocumentPickerResult =
  | { canceled: true }
  | { canceled: false; assets: PickedAsset[] };

export function getDocumentAsync(options: {
  type: string | string[];
  multiple: boolean;
  copyToCacheDirectory: boolean;
}): Promise<DocumentPickerResult> {
  return DocumentPicker.getDocumentAsync(options) as Promise<DocumentPickerResult>;
}

export function readFileAsBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: "base64" });
}

export async function getFileInfo(uri: string): Promise<{ exists: boolean; size?: number }> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists ? { exists: true, size: info.size } : { exists: false };
}

export function getFileSystemCacheDirectory(): string | null {
  return Platform.OS === "web" ? null : FileSystem.cacheDirectory;
}

export function writeFileFromBase64(uri: string, content: string): Promise<void> {
  return FileSystem.writeAsStringAsync(uri, content, { encoding: "base64" });
}

export async function isSharingAvailable(): Promise<boolean> {
  return Sharing.isAvailableAsync().catch(() => false);
}

export function shareFile(uri: string): Promise<void> {
  return Sharing.shareAsync(uri);
}
