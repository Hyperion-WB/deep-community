function withOpacity(variableName) {
  return ({ opacityValue }) => {
    if (opacityValue !== undefined) {
      return `color-mix(in srgb, var(${variableName}) calc(${opacityValue} * 100%), transparent)`;
    }
    return `var(${variableName})`;
  };
}

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"Noto Sans SC"',
          '"Source Han Sans SC"',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Liberation Mono"',
          '"Courier New"',
          'monospace',
        ],
      },
      colors: {
        wb: {
          bg: {
            page: withOpacity('--wb-bg-page'),
            surface: withOpacity('--wb-bg-surface'),
            elevated: withOpacity('--wb-bg-elevated'),
            subtle: withOpacity('--wb-bg-subtle'),
          },
          text: {
            primary: withOpacity('--wb-text-primary'),
            secondary: withOpacity('--wb-text-secondary'),
            muted: withOpacity('--wb-text-muted'),
          },
          danger: withOpacity('--wb-danger'),
          brand: withOpacity('--wb-brand'),
          success: withOpacity('--wb-success'),
          warn: withOpacity('--wb-warn'),
          info: withOpacity('--wb-info'),
          border: {
            subtle: withOpacity('--wb-border-subtle'),
            strong: withOpacity('--wb-border-strong'),
          },
          capsule: {
            track: withOpacity('--wb-capsule-track'),
            thumb: withOpacity('--wb-capsule-thumb'),
          }
        }
      },
      fontSize: {
        // 语义化小字号：使用 rem，跟随「界面字号」缩放（替代散落的 text-[10px]/[11px]）
        '3xs': ['0.625rem', { lineHeight: '0.9rem' }],
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        'capsule': '9999px',
        '2xl': '18px',
        '3xl': '24px',
      },
      boxShadow: {
        'capsule': 'var(--wb-capsule-shadow)',
        'card': 'var(--wb-card-shadow)',
        // 专业版工作台使用的两档轻阴影（迁移包原样式依赖）
        '2xs': '0 1px 2px 0 rgba(15, 23, 42, 0.05)',
        'xs': '0 1px 3px 0 rgba(15, 23, 42, 0.08), 0 1px 2px -1px rgba(15, 23, 42, 0.06)',
      },
      transitionTimingFunction: {
        'spring-fast': 'var(--wb-spring-fast)',
        'spring-smooth': 'var(--wb-spring-smooth)',
        'spring-bounce': 'var(--wb-spring-bounce)',
      }
    },
  },
  plugins: [],
}
