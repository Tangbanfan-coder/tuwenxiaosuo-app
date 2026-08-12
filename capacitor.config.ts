import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.illustratedstory.app',
  appName: '叙影',
  webDir: 'dist',
  backgroundColor: '#171715',
  android: {
    allowMixedContent: false,
    backgroundColor: '#171715',
    loggingBehavior: 'debug',
  },
}

export default config
