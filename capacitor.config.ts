import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.illustratedstory.app',
  appName: '图文小说',
  webDir: 'dist',
  backgroundColor: '#171715',
  android: {
    allowMixedContent: false,
    backgroundColor: '#171715',
  },
}

export default config
