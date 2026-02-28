import type { ExpoConfig } from "expo/config";

const DEV_ICON = "../../assets/T3 Code blueprint-macOS-Default-1024x1024@1x.png";
const PROD_ICON = "../../assets/T3 Code-macOS-Default-1024x1024@1x.png";

const isDevelopment = process.env.NODE_ENV !== "production";
const iconPath = isDevelopment ? DEV_ICON : PROD_ICON;

const config: ExpoConfig = {
  name: "T3 Code Mobile",
  slug: "t3-code-mobile",
  version: "0.1.0",
  orientation: "portrait",
  icon: iconPath,
  userInterfaceStyle: "automatic",
  splash: {
    image: iconPath,
    resizeMode: "contain",
    backgroundColor: "#f8fafc",
  },
  ios: {
    supportsTablet: true,
  },
  android: {
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: iconPath,
      monochromeImage: iconPath,
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: iconPath,
  },
};

export default config;
