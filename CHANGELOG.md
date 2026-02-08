# PokerSight GTO - 修改记录

## 修改日志

### [待修复] - 2026-02-07

**问题描述**:
- 待用户描述具体API问题

**技术分析**:
- 当前使用模型: `gemini-2.5-flash-native-audio-preview-12-2025`
- 当前响应模式: `Modality.AUDIO`
- API 库版本: `@google/genai@^1.34.0`

**待确认问题**:
1. 模型名称是否正确/是否过期
2. responseModalities 配置是否正确（当前设置为AUDIO，但需要的是TEXT响应）
3. API 地区限制问题

---

## 项目技术栈

- **前端**: React 19.2.3 + Vite 6.2.0
- **AI API**: Google Gemini Live API (@google/genai)
- **样式**: Tailwind CSS 4.1.18
- **语言**: TypeScript 5.8.2

---

## 常见问题排查

### 1. 地区限制
Gemini Live API 仅支持美国地区，需要使用VPN连接

### 2. API Key
确保 `.env.local` 中配置了正确的 `GEMINI_API_KEY`

### 3. 模型版本
Gemini 模型可能会更新，需要检查最新的模型名称
