# Antigravity Browser Bridge

Chrome/Edge extension + MCP server для управления браузером из Antigravity IDE.

## Архитектура

```
Chrome Extension (side panel)
  └── WebSocket ──► MCP Server (localhost:7842)
                         └── stdio ──► Antigravity IDE
```

Extension захватывает контекст страницы и принимает команды от IDE-агента.

## Структура проекта

```
AntiBrowserExtension/
├── antigravity-browser-extension/
│   ├── extension/              ← загружается в Chrome как unpacked
│   │   ├── manifest.json       MV3, sidePanel, scripting, tabs
│   │   ├── background.js       Service Worker + WS bridge
│   │   ├── content.js          DOM операции (getContext, click, type, scroll)
│   │   ├── sidepanel.html      UI боковой панели (статус и логи)
│   │   └── sidepanel.js        Логика панели и кнопок
│   ├── mcp-server/
│   │   ├── server.js           MCP (stdio) + WebSocket сервер на :7842
│   │   └── package.json
│   └── mcp-browser.json        Готовый конфиг для .mcp.json
└── hermes-antigravity-extension/
    └── HERMES_ANTIGRAVITY_INTEGRATION_PLAN.md
```

## MCP Tools

| Tool | Описание |
|------|----------|
| `browser_get_context` | URL, title, текст страницы, выделение, заголовки, ссылки, формы |
| `browser_navigate` | Перейти по URL |
| `browser_click` | Клик по CSS-селектору или видимому тексту |
| `browser_type` | Ввод текста в поле |
| `browser_screenshot` | Скриншот видимой области |
| `browser_get_tabs` | Список открытых вкладок |
| `browser_switch_tab` | Переключение вкладки по индексу или заголовку |
| `browser_scroll` | Прокрутка страницы |
| `browser_get_element` | Инфо об элементе: атрибуты, позиция, значение |

## Установка

### 1. Загрузить extension в Chrome

1. Открыть `chrome://extensions`
2. Включить **Developer mode**
3. **Load unpacked** → выбрать папку:
   ```
   .../AntiBrowserExtension/antigravity-browser-extension/extension
   ```

### 2. Подключить к Antigravity IDE

Добавить в `C:\Users\may\.gemini\antigravity\mcp-config.json`:

```json
"browser": {
    "command": "node",
    "args": [
        "C:/Users/may/.gemini/antigravity/scratch/_PROJECTS/AntiBrowserExtension/antigravity-browser-extension/mcp-server/server.js"
    ]
}
```

> Уже добавлено в глобальный mcp-config.json (2026-09-02).

### 3. Запуск

**Через IDE (автоматически):** IDE запускает server.js через MCP stdio, WS поднимается на :7842.

**Вручную (standalone):**
```powershell
cd .../antigravity-browser-extension/mcp-server
node server.js --ws-only
```

### 4. Подключение extension

Extension автоматически подключается к `ws://localhost:7842` с переподключением каждые 3 секунды.
Статус виден в боковой панели (зелёная точка = Connected).

## Как использовать

После подключения агент в IDE видит browser-инструменты. Примеры запросов:

- *"что сейчас открыто в браузере?"* → `browser_get_context`
- *"перейди на google.com"* → `browser_navigate`
- *"нажми кнопку Login"* → `browser_click`
- *"сделай скриншот"* → `browser_screenshot`
- *"какие вкладки открыты?"* → `browser_get_tabs`

## Отличие от Hermes Browser Extension

| | Hermes | Antigravity Browser Bridge |
|--|--------|---------------------------|
| Связь с агентом | HTTP API к Hermes runtime | MCP stdio → Antigravity IDE |
| UI | Полноценный чат в side panel | Инструмент для IDE, лог в side panel |
| Код extension | ~200KB (app.js) | ~15KB total |
| Подход | Self-contained агент в браузере | Bridge к уже умному IDE-агенту |
| Кастомизация | Плагины Hermes | Skills/Rules Antigravity |

## Порты

- `7842` — WebSocket (extension ↔ MCP server)
- MCP transport: stdio (IDE ↔ server.js)

## Версии

| Версия | Дата | Изменения |
|--------|------|-----------|
| 0.1.0 | 2026-09-02 | Первый релиз: WS bridge, 9 MCP tools, side panel UI |
