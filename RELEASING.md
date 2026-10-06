# Выпуск MegaProxy

Процесс аналогичен AndroidMegaProxy: ручной запуск с версией → релизный PR →
обязательные проверки → слияние → тег → сборка и GitHub Release.

## Однократная настройка

1. Слейте PR с `.github/workflows/prepare-release.yml` и `release.yml` в `main`.
   Ручной workflow появится в Actions после этого слияния.
2. Создайте fine-grained GitHub PAT для BrowserMegaProxy с разрешениями
   **Contents: Read and write**, **Pull requests: Read and write**,
   **Actions: Read-only**, **Checks: Read-only**. Владелец токена должен иметь
   право создавать ветки/теги и сливать PR в этот репозиторий.
3. В **Settings → Secrets and variables → Actions → New repository secret**
   сохраните токен как `RELEASE_BOT_TOKEN`. Это тот же подход, что в AndroidMegaProxy.
   Обычный `GITHUB_TOKEN` не запустит CI от созданного им PR и release workflow
   от созданного им тега; [GitHub описывает это ограничение](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
4. Сохраните обязательные проверки `Linters`, `Unit tests`, `Chromium tests`,
   `Firefox tests` для `main`. Они уже настроены в ruleset Protect Main.

5. Создайте отдельный API-ключ в [OpenAI Platform → API keys](https://platform.openai.com/api-keys):
   выберите проект, нажмите **Create new secret key** и сохраните выданный ключ.
   Для restricted-ключа разрешите запись в **Responses API** (`POST /v1/responses`).
   Проект должен иметь настроенную оплату API и доступ к выбранной модели;
   подписка ChatGPT не заменяет оплату API.
6. В **Settings → Secrets and variables → Actions → Secrets** добавьте
   repository secret **OPENAI_API_KEY** с этим ключом. В файлы репозитория ключ не записывайте.
7. Во вкладке **Variables** добавьте repository variable **OPENAI_RELEASE_MODEL**
   со значением **gpt-6-luna**, как в других репозиториях. Без переменной используется
   та же модель; секрет с этим именем тоже поддерживается для совместимости.
   Поле **model** при запуске workflow имеет приоритет над переменной и секретом.

Генератор использует [OpenAI Responses API](https://developers.openai.com/api/docs/quickstart)
и [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).
Он отправляет историю коммитов и статистику изменённых файлов с предыдущего релизного
тега, для первого выпуска — всю историю. Содержимое файлов не отправляется;
сохранение ответа в API отключено (`store: false`). EN/RU changelog сохраняется
в `releases/vX.Y.Z.md`, включается в релизный PR и публикуется в GitHub Release
из коммита тега. Повторная публикация не вызывает OpenAI заново.
При ошибке API или некорректном ответе подготовка останавливается до коммита и пуша.
Android signing и учётные данные магазинов для GitHub-релиза не нужны.

## Каждый выпуск

1. Слейте нужные изменения в `main`.
2. Откройте **Actions → Prepare and merge release → Run workflow**.
3. Выберите **main** и укажите новую версию без `v`, например `0.1.1`.
   Поле **model** можно оставить пустым для `OPENAI_RELEASE_MODEL` / `gpt-6-luna`
   или указать другой доступный вам идентификатор модели.
   Она должна быть выше `package.json`; допустимы три компонента 0–65535,
   без ведущих нулей и суффиксов `beta`/`rc`.
4. Дождитесь завершения. Workflow сгенерирует EN/RU changelog, обновит `package.json` и `package-lock.json`,
   создаст `release/vX.Y.Z` и PR, дождётся четырёх проверок, сольёт PR и поставит
   тег на коммит слияния. Он не использует обход проверок через `--admin`.
5. Проверьте **Release extension artifacts** и страницу **Releases**.
   Перед публикацией тег проходит тот же полный CI, что и PR.

Если во время проверки изменился `main` и PR стал отставать, обновите его ветку
кнопкой Update branch, дождитесь CI и слейте PR вручную. Workflow проверяет исходный
коммит PR и после обновления ветки не сольёт его автоматически; поставьте тег на
коммит слияния по инструкции восстановления ниже. При падении workflow после создания PR
проверьте этот PR; не запускайте повторную подготовку той же версии поверх существующей ветки.

## Файлы релиза

- `MegaProxy-chromium-vX.Y.Z.zip` — Chrome и Opera: распакованная установка
  в режиме разработчика или загрузка в соответствующий магазин.
- `MegaProxy-firefox-vX.Y.Z.zip` — неподписанный Firefox-пакет: временная
  установка через `about:debugging` или отправка Mozilla на подпись.
- `MegaProxy-source-vX.Y.Z.zip` — исходники из коммита тега для ревью и воспроизводимой сборки.
- `MegaProxy-store-materials-vX.Y.Z.zip` — актуальные скриншоты, иконки,
  описания EN/RU и документы для магазинов.
- `SHA256SUMS` — SHA-256 всех четырёх архивов.

В архивах расширения `manifest.json` находится в корне. Материалы магазинов
перегенерируются для выпуска. Готовые assets GitHub Release не имеют 14-дневного
срока хранения, который установлен для PR-артефактов. Повторный запуск публикации
восстанавливает описание из changelog тега, перезаписывая ручные правки описания.

## Подпись Firefox

Подпись выдаёт Mozilla, собственный сертификат разработчика её не заменяет.
Для публичного магазина используйте канал **listed**; для установки XPI из
GitHub Release без карточки AMO — **unlisted**.

Вручную:

1. Войдите в [AMO Developer Hub](https://addons.mozilla.org/developers/) и примите
   соглашение разработчика.
2. Загрузите Firefox ZIP и выберите **On this site** для AMO либо **On your own**
   для самостоятельного распространения.
3. При запросе исходников приложите source ZIP. Сборка: Node.js 22+,
   `npm ci && npm run build`; Firefox-пакет находится в `dist/firefox`.
4. После проверки скачайте подписанный `.xpi`. Для самостоятельного распространения
   добавьте его к GitHub Release через **Edit release → Attach files**.
   Подписанный XPI не нужно перепаковывать.

Подписывание также поддерживает [официальный web-ext](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign).
Создайте [ключи AMO API](https://addons.mozilla.org/developers/addon/api/key/) и
передайте их через переменные `WEB_EXT_API_KEY` и `WEB_EXT_API_SECRET`, не через
репозиторий. Пример для самостоятельного распространения из checkout тега:

```sh
npm ci
npm run build
npm run release:assets
# WEB_EXT_API_KEY и WEB_EXT_API_SECRET уже заданы в окружении.
npx --yes web-ext@10 sign \
  --channel unlisted \
  --source-dir dist/firefox \
  --upload-source-code dist/release/MegaProxy-source-vX.Y.Z.zip \
  --artifacts-dir dist/signed
```

Замените `X.Y.Z` версией тега. `web-ext sign --channel unlisted` отправляет пакет
в Mozilla и скачивает подписанную копию после одобрения. Канал `listed` отправляет
версию на публичное размещение; для первой карточки нужны также метаданные AMO.
Проверка может потребовать ручного ревью и занять больше времени, чем ожидание CLI.
[Mozilla описывает оба канала и подпись](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).
Автоподписывание и автопубликация в магазины в этих workflow не включены.

## Публикация в магазинах

Для Chrome Web Store и Opera Add-ons загрузите Chromium ZIP. Для Firefox Add-ons
загрузите Firefox ZIP через свой аккаунт Mozilla. Используйте описания,
скриншоты и политику из [store/](store/README.md); укажите публичный URL политики.
Для Opera перед публикацией проверьте релиз в целевой версии браузера.

## Повторная публикация после сбоя

Если release workflow упал после появления тега, исправьте внешнюю причину
и выберите **Re-run failed jobs**. Существующие assets этого тега заменяются;
новый релиз с тем же тегом не создаётся. Если меняется код, выпускайте новую версию.

Если подготовка упала после слияния PR, но до создания тега, поставьте тег вручную
на коммит слияния этого PR (замените значения):

```sh
git fetch origin main
git tag vX.Y.Z MERGE_COMMIT_SHA
git push origin refs/tags/vX.Y.Z
```

Версия тега обязана совпадать с `package.json` на этом коммите; там же должен быть
непустой EN/RU changelog `releases/vX.Y.Z.md`. Для ручного выпуска его можно написать
самостоятельно или сгенерировать командой `node scripts/release.mjs notes X.Y.Z`
с `OPENAI_API_KEY` в окружении и закоммитить до создания тега. Тег автоматически
запустит release workflow и полный CI. Релиз для текущей версии без её повышения
тоже можно запустить этим способом после слияния релизных workflow в `main`.
