# CM6 Migration Plan

## Summary

Документ описывает реализацию миграции редактора на CodeMirror 6 в режиме dual-run.
Цель - перенести весь текущий функционал редактора на CM6, оставить контролируемый fallback на legacy и затем удалить legacy-путь вручную по чеклисту.

## Architecture decisions

1. Режим по умолчанию: `cm6`.
2. Fallback-режим: `legacy`.
3. Переключатель режима:
   - query: `?editor=cm6|legacy`,
   - persistence: `localStorage` (используется при отсутствии query).
4. Source of truth: только CM6 state.
5. Python-only режим и подсветка.

## Phases

## Phase 0 - Baseline and safety rails

1. Зафиксировать текущую стабильную базу тестов (`editor-regression`, unit).
2. Добавить smoke-check переключателя режима.
3. Включить телеметрию/логирование режима редактора для диагностики (минимальный объём).

Acceptance:
- одинаковый проект открывается в `cm6` и `legacy`,
- переключение режима не ломает запуск/сохранение.

## Phase 1 - CM6 core integration

1. Вынести редакторный adapter-слой:
   - `getValue()`,
   - `setValue()`,
   - `focus()`,
   - `setSelection()`,
   - `getSelection()`,
   - `onChange()`,
   - `onScroll()`.
2. Подключить CM6 как основной путь и сохранить legacy adapter.
3. Убрать зависимость UI-логики от прямого `textarea` API вне adapter.

Acceptance:
- основное редактирование работает в `cm6`,
- fallback `legacy` активируется toggled-режимом.

## Phase 2 - Full parity migration

Перенести все функции редактора (без исключений):

1. line numbers,
2. синтаксическая подсветка Python,
3. хоткеи (минимально совместимо),
4. tab/indent/enter-логика,
5. выделение строки и массовое выделение,
6. поддержка font size control,
7. корректная работа в mobile/tablet режимах,
8. интеграция с запуском кода и snapshot/remix/embed.

Acceptance:
- полный parity с текущим UX на уровне сценариев,
- нет визуального drift в целевых тестах.

## Phase 3 - Regression hardening

1. Прогон полного набора `editor-regression`.
2. Прогон matrix-проверок (Chromium/Firefox/WebKit через актуальный CI flow).
3. Добавление missing coverage для всех обнаруженных edge-cases.

Acceptance:
- зелёные обязательные пайплайны,
- отсутствие известных редакторных дефектов класса scroll/caret drift.

## Phase 4 - Legacy removal decision gate

Ручной gate на удаление legacy:

1. Проверить чеклист удаления (ниже).
2. Подтвердить отсутствие критичных откатов.
3. Принять решение об удалении вручную.

## Legacy removal checklist

1. CM6 путь покрывает все обязательные user flows.
2. `editor-regression` стабильно зелёный.
3. Нет открытых P1/P2 дефектов по редактору.
4. Toggle использовался для отката и больше не нужен.
5. Документация обновлена (`README`, `TECHNICAL_GUIDE`, migration docs).
6. Подготовлен отдельный PR/commit на удаление legacy adapter и мёртвого кода.

## Risks and mitigations

1. Риск: регрессия хоткеев на разных платформах.
   - Митигировать: кроссплатформенные шорткаты в e2e (`ControlOrMeta` где нужно).
2. Риск: неполный parity в mobile/tablet.
   - Митигировать: отдельные сценарии для адаптивных режимов в e2e.
3. Риск: скрытые зависимости на старый `textarea`.
   - Митигировать: adapter boundary + поиск прямых обращений и их вырезание.

## Deliverables

1. Кодовый dual-run с default `cm6`.
2. Полный parity функционала редактора.
3. Обновлённые тесты и CI-валидаторы.
4. Документированный план и решение по удалению legacy.

## Progress snapshot (2026-02-07)

### Done

1. Добавлены модули:
   - `assets/cm6-editor-adapter.js`
   - `assets/legacy-editor-adapter.js`
   - `assets/editor-adapter-factory.js`
   - `assets/utils/editor-mode-utils.js`
2. Добавлен локальный CM6 bundle pipeline:
   - `scripts/build-cm6-bundle.mjs`
   - `assets/vendor/cm6/codemirror.bundle.js`
3. Внедрён UI toggle режима редактора в `editor-controls`.
4. В runtime добавлены:
   - `state.editorMode`,
   - переключение `cm6 <-> legacy` с сохранением текста/selection/scroll,
   - persistence режима в localStorage (`shp-editor-mode`),
   - query override (`?editor=cm6|legacy`).
5. Расширены e2e-тесты:
   - editor mode tests,
   - расширенный `[editor-regression]`,
   - `legacy editor fallback sanity`.
6. CI-структура на matrix:
   - Linux: Chromium + Firefox,
   - отдельный macOS job для WebKit.

### In progress

1. Дополнительный parity-прогон полного `tests/ide.spec.js` для CM6 default.
2. Финальная сверка mirrored runtime (`assets/app.js`) и primary runtime (`assets/skulpt-app.js`) перед фиксацией этапа.

### Notes

1. Локальный Linux прогон WebKit может падать с `WebKit encountered an internal error` до выполнения самих ассертов.
2. Релизный gate для WebKit считается по macOS CI job, не по локальному Linux окружению.
