import { Config } from "./src/config";

export const defaultConfig: Config = {
  cleanupAfterUpload: false,
  uploadToGCP: false,
  name: "defaultFolderAttic",
  url: "https://www.builder.io/c/docs/developers",
  match: "https://www.builder.io/c/docs/**",
  maxPagesToCrawl: 50,
  outputFileName: "output.json",
  maxTokens: 2000000
};
