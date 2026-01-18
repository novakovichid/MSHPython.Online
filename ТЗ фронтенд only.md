# Окончательное техническое ТЗ — Frontend‑only Web‑Python IDE (аналог Trinket Python3) для GitHub Pages

## 0) Коротко о продукте
Статический веб‑сервис (деплой на GitHub Pages), который даёт в браузере:
- редактор Python‑проекта с **несколькими файлами** (строго **один каталог**);
- запуск **активного файла** как entry point;
- **консоль**: потоковый stdout/stderr + **stdin в консоли** для `input()` (никаких `>>>`, никакого `prompt()` как UX);
- **turtle** (рисование в canvas);
- **шеринг по ссылке** как **immutable snapshot**;
- при открытии snapshot‑ссылки можно **локально редактировать** без влияния на исходник и делать **Remix** (копию).

---

## 1) Жёсткие ограничения (must-have)
### 1.1 Frontend‑only
- **Никакого бекенда**, API, серверного раннера, БД, авторизации.
- Никаких serverless/worker‑провайдеров (Cloudflare Workers, Vercel/Netlify functions, Firebase и т. п.).

### 1.2 Никаких внешних сервисов/доменных зависимостей
- Приложение **не должно** делать сетевые запросы к доменам, отличным от origin GitHub Pages.
- Python runtime (Pyodide), wasm и все пакеты должны быть **self-hosted в репозитории**.

### 1.3 Никакого CI/CD
- Не использовать GitHub Actions/пайплайны.
- Сборка (если есть) выполняется локально разработчиком; артефакты коммитятся в репозиторий.

### 1.4 Без “ручных действий” для пользователя
- Пользователь просто открывает страницу — всё работает.
- Внутренние технологии (Web Worker/Service Worker) допускаются, но **должны запускаться автоматически**.

---

## 2) Нерушимые функциональные требования
1) **Multi‑file, одна область видимости**: файлы импортируются друг другом (`import utils` → `utils.py` в корне).
2) **Один каталог**: никаких папок/пакетов с подпапками.
3) **Entry point = активный файл**: Run запускает текущую вкладку `.py`.
4) **Консоль без REPL prompt**: никакого `>>>`.
5) **stdin в консоли**: `input()` должен работать через консольный инпут, не через `prompt()`.
6) **Stop/Interrupt**: возможность остановить зависший/долгий код.
7) **Share без регистрации**: ссылка открывается у любого, даже в инкогнито.
8) **ShareId = immutable snapshot**: ссылка всегда указывает на зафиксированную версию.
9) **Read‑only относительно исходника, но редактирование разрешено**: в snapshot‑режиме правки не влияют на baseline; сохраняются локально до Remix.
10) **Remix/Fork**: создаёт новый локальный проект из текущего состояния (baseline + draft).
11) **turtle работает**: типовые учебные примеры рисуют в canvas.

---

## 3) Технологический стек (обязательный минимум)
### 3.1 Python runtime
- **Pyodide** (CPython в WebAssembly) как единственный runtime.
- Self-hosted ассеты Pyodide и требуемые пакеты в репозитории.

### 3.2 Исполнение
- Python выполняется в **Web Worker** (иначе UI будет фризить).
- UI (редактор/консоль/canvas) — main thread.
- Коммуникация UI ↔ Worker: `postMessage`.
- Для “идеального” `input()` и interrupts используется **SharedArrayBuffer**.

### 3.3 Service Worker
- Разрешён и обязателен для:
  - **cross‑origin isolation (COI)**, чтобы включить SharedArrayBuffer на GitHub Pages;
  - оффлайн‑кеша (опционально, но рекомендовано).
- Пользователь ничего не включает вручную.

---

## 4) Поддерживаемые браузеры (важно)
Так как `input()` без prompt + надёжный Stop требуют SharedArrayBuffer:
- Поддерживаем **браузеры с COI + SharedArrayBuffer**.
- Если среда не поддерживается — показываем экран “Неподдерживаемый браузер/режим”, запуск Python блокируем.

> Это единственный честный способ “не терять функционал” без сервера.

---

## 5) Роутинг и страницы (GitHub Pages)
GitHub Pages статичен ⇒ используем **hash‑router** (без серверных rewrite).

- `/#/` — Landing
- `/#/p/{projectId}` — локальный проект (editable)
- `/#/s/{shareId}` — snapshot‑ссылка (immutable baseline + local draft)
- `/#/embed` — embed‑режим (параметры query)

---

## 6) UX/UI (MVP)
### 6.1 Макет
- Слева/сверху: список/вкладки файлов + кнопка “+”.
- Центр: редактор кода.
- Низ: консоль (stdout/stderr) + строка ввода.
- Справа/вкладка: turtle canvas.

### 6.2 Кнопки и состояния
**В проекте (`/#/p/...`)**
- Run, Stop, Clear Console
- Share (сформировать snapshot‑ссылку)
- Export (zip/json)
- Индикатор сохранения (локально): Saved / Saving

**В снапшоте (`/#/s/...`)**
- Run, Stop, Clear Console
- Remix (создать проект)
- Reset to snapshot
- Плашка: “Shared snapshot. Your edits are local until Remix.”

### 6.3 Настройки редактора (MVP)
- tab size 2/4
- word wrap on/off
- auto focus editor on load (опционально)

---

## 7) Файлы и File Library (без папок)
### 7.1 Операции с файлами
- Create (кнопка “+”)
- Rename
- Delete
- Duplicate (опционально)

Ограничения имён:
- уникально в проекте
- запрет `/`, `\`, `..`, управляющих символов
- рекомендованный regex: `^[A-Za-z0-9._-]+$`

### 7.2 File Library (MVP)
- UI‑загрузка файлов данных (txt/csv/json/картинки) в проект.
- Хранение в IndexedDB как blob (см. схему).
- При запуске файлы доступны через `open()` из корня проекта.

---

## 8) Хранение данных (IndexedDB)
Все данные — локально в браузере.

### 8.1 Схема (conceptual)
**projects**
- `projectId` (uuid/ulid)
- `title`
- `files`: [{ name, content }]
- `assets`: [{ name, mime, blobId }] (опционально)
- `lastActiveFile`
- `updatedAt`

**blobs**
- `blobId`
- `data` (Blob)

**drafts**
- key: `draft:s:{shareId}`
- `overlayFiles`: map filename→content (только изменённые)
- `draftLastActiveFile`
- `updatedAt`

**recent**
- список последних projectId

---

## 9) Шеринг без бэка: snapshot как payload в URL
### 9.1 Принцип
Так как нет сервера, “share по ссылке” реализуется как:
- сериализация проекта (без локальных секретов) → JSON
- компрессия (deflate/brotli)
- base64url
- вкладывание payload в query‑параметр

Формат ссылки (пример):
- `/#/s/{shareId}?p={payload}`

Где:
- `payload` = base64url(compress(json))
- `shareId` = сокращённый sha256(payload_bytes) (для красоты и устойчивого id)

### 9.2 Immutable по определению
Новая публикация = новый payload ⇒ новый shareId.

### 9.3 Лимиты (обязательные)
URL ограничен браузерами/мессенджерами ⇒ фиксируем лимиты проекта так, чтобы “share” работал стабильно:

- `MAX_FILES`: 30
- `MAX_TOTAL_TEXT_BYTES` (сумма всех `content` до компрессии): 250 KB
- `MAX_SINGLE_FILE_BYTES`: 50 KB
- `MAX_ASSET_BYTES`: 0 в snapshot (MVP) **или** строгий лимит и отдельный механизм (см. ниже)

Поведение:
- Если превышено: UI показывает “Share недоступен: проект слишком большой” и предлагает Export.

### 9.4 Важно про бинарные ассеты
Два допустимых режима (выбрать один для MVP):
- **MVP‑A (рекомендовано):** snapshot‑ссылки содержат только текстовые файлы; assets доступны только через Export/Import.
- **MVP‑B:** assets включаются в payload как base64 (жёстко ограничить общий размер, иначе ссылки ломаются).

---

## 10) Snapshot‑режим: локальные правки без влияния на baseline
### 10.1 Baseline
- baseline = содержимое payload из URL (immutable).

### 10.2 Draft overlay
- любые правки в редакторе пишутся в IndexedDB `drafts[draft:s:{shareId}]` как overlay.
- Run использует baseline+overlay (эффективное состояние).

### 10.3 Reset
- удаляет draft overlay, возвращает baseline.

### 10.4 Remix
- создаёт новый `projectId` и сохраняет “эффективное состояние” (baseline+overlay) в `projects`.

---

## 11) Исполнение Python (Runner в Web Worker)

### 11.1 Инициализация
- При старте страницы поднимаем worker и инициализируем Pyodide из self-hosted `indexURL`.
- Проверяем COI/SAB требования; при отсутствии — блокируем запуск и показываем ошибку совместимости.

### 11.2 Подготовка FS на запуск
Перед каждым Run:
1) очистить виртуальную FS (или пересоздать in‑memory root);
2) записать все файлы проекта в корень;
3) записать assets (если поддерживаем в runtime);
4) установить cwd = корень.

### 11.3 Entry point
- Запускаем активный файл как `__main__`.
- Требование: активный файл может импортировать другие файлы проекта.

### 11.4 stdout/stderr
- перехватывать поток вывода и чанками отправлять в UI:
  - `{type:"stdout", data:"..."}`
  - `{type:"stderr", data:"..."}`

### 11.5 stdin (обязательное)
UI:
- хранит очередь строк ввода.
- поле ввода активно только когда run RUNNING.

Worker:
- реализует `stdin()` как блокирующий источник:
  - если очередь пуста → `Atomics.wait` на SAB до ввода;
  - если не пуста → возвращает строку.

### 11.6 Stop/Interrupt (обязательное)
Два уровня:
- **Soft interrupt**: через interrupt buffer Pyodide (SAB).
- **Hard stop**: `worker.terminate()` и создание нового worker (гарантированно останавливает всё).

### 11.7 Таймауты и защита от “вечных” циклов
- wall‑time timeout (например 10 секунд по умолчанию) → soft interrupt, затем hard stop.
- лимит объёма вывода (например 2 MB) → прекращаем приём, показываем “output truncated”.

---

## 12) Turtle (обязательная поддержка)
Стандартный `turtle` обычно завязан на Tk, в браузере не работает.

Решение: **turtle‑shim**:
- в Python окружении подменяем модуль `turtle`;
- он генерирует события рисования;
- UI рендерит события в canvas.

### 12.1 Формат событий (MVP)
- `init`: `{w,h,bg}`
- `clear`: `{}`
- `line`: `{x1,y1,x2,y2,color,width}`
- `dot`: `{x,y,size,color}`
- `text`: `{x,y,text,color,font}`
- `flush`: `{}` (опционально)

### 12.2 Поведение
- Новый Run сбрасывает canvas.
- `done()`/`mainloop()` — no-op.

---

## 13) Embed‑режим (как у Trinket, но статически)
Embed — это тот же SPA, но с UI‑флагами в query.

### 13.1 Параметры
- `display=side|output|toggle`
- `mode=runOnly|consoleOnly|allowEither`
- `autorun=1|0`
- `instructionsFirst=1|0` (если вводим инструкцию)
- `readonly=1|0` (для embed по умолчанию 1)

### 13.2 Поведение
- В embed по умолчанию нет сохранения в projects (если не нажали Remix/Open).

---

## 14) Политика безопасности (в рамках фронтенда)
### 14.1 CSP (через meta)
Зафиксировать минимальную CSP (пример; может потребовать адаптации под сборщик):
- `default-src 'self'`
- `connect-src 'self'`
- `img-src 'self' data: blob:`
- `script-src 'self' 'wasm-unsafe-eval'`
- `worker-src 'self' blob:`
- `style-src 'self' 'unsafe-inline'` (если нужно)

### 14.2 Ограничения
- Нельзя полностью “засандбоксить” Python в браузере как на сервере.
- Контроль риска: таймауты, hard stop worker, лимиты вывода, ограничения размера проектов.

---

## 15) Репозиторий и деплой на GitHub Pages (без CI/CD)
### 15.1 Структура (пример)
- `/index.html`
- `/assets/...` (bundle)
- `/vendor/pyodide/...` (pyodide.js/wasm/stdlib/packages)
- `/sw.js` (service worker: COI + cache)
- `/.nojekyll`
- `/README.md`

### 15.2 Деплой
- GitHub Pages раздаёт содержимое ветки/папки (например `/docs`).
- Сборка (если есть) выполняется локально; результат коммитится.
- Никаких workflow в `.github/workflows`.

---

## 16) Acceptance criteria (E2E)
1) **Multi‑file import**
   - `utils.py` → `def f(): return 1`
   - `main.py` → `import utils; print(utils.f())`
   - Run на `main.py` выводит `1`.

2) **Entry point = активный файл**
   - `a.py` печатает `A`, `b.py` печатает `B`
   - активный `a.py` → Run → `A`
   - активный `b.py` → Run → `B`

3) **stdin**
   - `name = input("Name? "); print("Hi,", name)`
   - Run → видно `Name? `
   - ввод `Ivan` → вывод `Hi, Ivan`

4) **Stop**
   - `while True: pass`
   - Run → Stop → выполнение прекращается, UI жив.

5) **Share = snapshot**
   - В проекте: Share → ссылка
   - Открыть ссылку в инкогнито → код и запуск совпадают с оригиналом.

6) **Snapshot editable locally**
   - В snapshot внести правку → Run использует правку
   - В другой инкогнито‑сессии без draft baseline неизменен.

7) **Reset**
   - В snapshot изменить → Reset → вернулся baseline.

8) **Remix**
   - В snapshot изменить → Remix → создан локальный проект, правки сохранены.

9) **turtle**
   - Пример рисования (квадрат/звезда) отображается на canvas
   - Новый Run очищает canvas.

10) **No external requests**
   - В DevTools Network нет запросов к внешним доменам.

11) **No CI/CD**
   - В репозитории нет `.github/workflows/*`.

---

## 17) Конфиг (значения по умолчанию)
- `RUN_TIMEOUT_MS`: 10_000
- `MAX_OUTPUT_BYTES`: 2_000_000
- `MAX_FILES`: 30
- `MAX_TOTAL_TEXT_BYTES`: 250_000
- `MAX_SINGLE_FILE_BYTES`: 50_000
- `TAB_SIZE`: 4
- `WORD_WRAP`: true

---

## 18) Явные решения для MVP (чтобы не расползлось)
- Runtime: Pyodide self‑hosted.
- Исполнение: Web Worker (авто).
- COI/SAB: Service Worker (авто).
- Share: snapshot в URL payload, без сервера.
- Storage: IndexedDB для проектов и draft.
- turtle: shim + canvas.
- Сеть: запрещена CSP (connect-src self).
