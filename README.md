# МШПайтон.Онлайн

[![Tests](https://github.com/novakovichid/MSHPython.Online/actions/workflows/tests.yml/badge.svg)](https://github.com/novakovichid/MSHPython.Online/actions/workflows/tests.yml)
[![Coverage Status](https://coveralls.io/repos/github/novakovichid/MSHPython.Online/badge.svg?branch=main)](https://coveralls.io/github/novakovichid/MSHPython.Online?branch=main)

Статус: релизная версия.

МШПайтон.Онлайн - браузерная Python IDE для учебных задач с поддержкой многофайловых проектов, консоли, Turtle-графики и шаринга по ссылке.

## Что умеет IDE

- Многофайловые проекты (`main.py` + модули `.py`).
- Запуск Python-кода прямо в браузере.
- Встроенная Turtle-графика.
- Шеринг проекта через snapshot-ссылку.
- Режим Snapshot:
  - локальный черновик изменений;
  - `Сброс` для отката к исходному снимку;
  - `Ремикс` для сохранения временной копии как постоянного локального проекта.
- Импорт/экспорт файлов проекта.

## Документация

- Пользовательское руководство (Markdown): `docs/USER_GUIDE.md`
- Техническое руководство: `docs/TECHNICAL_GUIDE.md`
- План системного рефакторинга: `docs/REFACTOR_PLAN.md`
- HTML-гайды:
  - Для пользователей: `docs/user_guide/for_users.html`
  - Для преподавателей: `docs/user_guide/for_teachers.html`

## Быстрый старт

### Вариант 1: локальный статический сервер

Windows:

```bash
serve.bat
```

Linux/macOS:

```bash
./serve.sh
```

macOS (двойной клик/Terminal):

```bash
./serve.command
```

По умолчанию используется порт `8000`.

С другим портом:

```bash
PORT=9000 ./serve.sh
```

### Вариант 2: Python вручную

```bash
python3 -m http.server 8000
```

Откройте в браузере:

- `http://127.0.0.1:8000`

## Разработка

### Установка зависимостей

```bash
npm ci
```

### Unit-тесты

```bash
npm run test:unit
```

### Unit + coverage

```bash
npm run test:unit:coverage
```

### E2E (Playwright)

```bash
npx playwright test
```

E2E в песочнице (Chromium):

```bash
npx playwright test -c playwright.sandbox.config.cjs
```

Editor regression в кросс-браузерной matrix (Chromium/Firefox/WebKit):

```bash
npx playwright test -c playwright.editor-matrix.config.cjs tests/ide.spec.js --grep "\\[editor-regression\\]"
```

Запуск только snapshot/remix сценариев:

```bash
npx playwright test tests/ide.spec.js --grep "remix|snapshot"
```

## Структура проекта (основное)

- `index.html` - основной интерфейс.
- `assets/skulpt-app.js` - основной frontend runtime.
- `assets/skulpt-styles.css` - основные стили интерфейса.
- `assets/app.js`, `assets/styles.css` - параллельная/зеркальная реализация.
- `assets/utils/*.js` - утилиты.
- `assets/worker.js` - worker-часть runtime.
- `tests/` - e2e и unit тесты.

## Ограничения

- Для работы нужен HTTP-сервер (протокол `file://` не поддерживается).
- Snapshot-ссылки ориентированы на код проекта (без вложенных загруженных ассетов).

## Требования

- Современный Chromium/Chrome/Safari/Firefox.
- Node.js и npm для тестов и dev-процессов.
- Python 3 для запуска локального статического сервера.
