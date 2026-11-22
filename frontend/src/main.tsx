import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { MotionPreferenceProvider } from './components/MotionPreferenceProvider.tsx'
import { applyCustomFont, getStoredCustomFont } from './utils/fontUtils'
import { applyColorPalette, getStoredPalette } from './utils/themePalette'
import { applyUiPreferences, getUiPreferences } from './utils/appearance'

// 初始化应用本地系统自定义字体设置
applyCustomFont(getStoredCustomFont());

// 初始化应用当前设备持久化的配色方案（不重复写入 localStorage）
applyColorPalette(getStoredPalette(), { persist: false, animate: false });

// 初始化字号 / 密度 / 动效 / 背景质感 / 代码块主题 / 强调色
applyUiPreferences(getUiPreferences());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <MotionPreferenceProvider>
        <App />
      </MotionPreferenceProvider>
    </ErrorBoundary>
  </StrictMode>,
)
