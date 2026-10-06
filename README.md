# MegaProxy

Расширения для Chromium и Firefox.
HTTP/HTTPS CONNECT, несколько профилей, авторизация, knock host, исключения доменов,
импорт/экспорт профилей, локальный обход, проверка подключения,
светлая/тёмная/системная тема. Интерфейс без внешних библиотек и ресурсов.

## Сборка и установка

Нужны Node.js 22+ и npm.

```sh
npm ci
npm run build
```

- **Chromium 120+**: `chrome://extensions` → режим разработчика → загрузить распакованное расширение → `dist/chromium`.
- **Firefox 128+**: `about:debugging#/runtime/this-firefox` → загрузить временное дополнение → `dist/firefox/manifest.json`. В `about:addons` разрешите работу в приватных окнах: это обязательное условие Firefox для `proxy.settings`. Для постоянной установки потребуется подпись Mozilla.

В каждом PR workflow **Extension checks** публикует два ZIP-артефакта:
**MegaProxy-chromium** и **MegaProxy-firefox**. Откройте запуск из проверок PR,
скачайте нужный архив в разделе **Artifacts** и распакуйте его. `manifest.json`
находится в корне архива; установите распакованную папку по инструкции выше.
Архивы доступны 14 дней и загружаются сразу после сборки, до запуска тестов.

Откройте «Настройки» из попапа: профили, импорт/экспорт, маршрутизация, язык и тема находятся на отдельной
странице. Добавьте профиль с адресом сервера, портом, логином и паролем.
В попапе доступны быстрые действия: выбор и подключение профиля, отключение и knock.
Отключение возвращает управление прежним настройкам браузера. Изменение активного профиля применяется сразу.
Knock открывает отдельную вкладку, которую можно закрыть после загрузки.
В «Настройки» → «Язык» доступны «Авто», «Русский» и «English». По умолчанию «Авто»:
язык интерфейса браузера определяется через `i18n.getUILanguage()` — русский для `ru`
и его региональных вариантов, английский для остальных языков. Ручной выбор сохраняется
локально и применяется сразу, включая ошибки и подсказки. Имена профилей не переводятся.
Переводы находятся в `extension/_locales/{en,ru}/messages.json`; язык описания расширения
в браузере определяется самим браузером независимо от ручного выбора в popup.

Пароли сохраняются в `storage.local` и по умолчанию синхронизируются через `storage.sync`; синхронизацию паролей можно отключить отдельно. Само расширение их не шифрует.
В Chromium приватный режим по умолчанию не включён. Firefox требует разрешения приватных окон для `proxy.settings`; активный профиль действует и в этих окнах.

## Запуск для разработки

Установите обычный актуальный Google Chrome и/или Firefox. Поддерживаются macOS, Linux
и Windows; нужны Node.js 22+ и `npm ci`.

```sh
npm start             # Chrome по умолчанию
npm start --chrome    # Chrome
npm start --firefox   # Firefox
npm start -- --watch  # Chrome с автоматической пересборкой
npm start -- --firefox --watch # Firefox с автоматической пересборкой
```

Некоторые версии npm предупреждают о неизвестных флагах. Переносимый вариант передачи
аргументов: `npm start -- --chrome` и `npm start -- --firefox`.

`--watch` отслеживает `extension/` и `scripts/build.mjs`: после изменений выполняется
сборка и перезагрузка расширения без перезапуска браузера. Настройки сохраняются.
В Chrome также обновляются открытые вкладки расширения; в Firefox страницы
расширения при необходимости нужно открыть заново. Ошибка сборки выводится в терминал,
наблюдение продолжается до следующего изменения.

При каждом запуске расширение пересобирается и автоматически загружается в браузер.
Постоянные отдельные профили находятся в `.browser-profiles/chrome` и
`.browser-profiles/firefox`; каталог исключён из Git. Профили прокси, язык, тема
и другие данные браузера сохраняются между запусками. Закройте предыдущую сессию
перед повторным запуском. Завершение — закрыть браузер или нажать Ctrl+C в терминале.

Chrome открывает интерфейс расширения во вкладке. В актуальном обычном Chrome
[`--load-extension` отключён](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY), поэтому используется DevTools Protocol с флагом
`--enable-unsafe-extension-debugging` только в отдельном профиле разработки.
Firefox открывает `about:addons` и устанавливает временное дополнение при каждом
запуске через локальный Mozilla DevTools server; разрешение приватных окон,
необходимое для `proxy.settings`, предоставляется этому дополнению в его отдельном профиле.
Данные дополнения сохраняются, подпись Mozilla для такого запуска не нужна.

На macOS Firefox ищется в `/Applications/Firefox.app`, на Linux — как `firefox` в PATH,
на Windows — в Program Files / Program Files (x86) / LocalAppData. Chrome используется
из стандартного расположения установленного браузера. На Linux для `npm start`
нужна графическая сессия.

## Авторизация и probe resistance

| Браузер  | Отправка до 407                                                                  | Knock                                                                                             |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Firefox  | Сохранённые логин и пароль передаются через `ProxyInfo.proxyAuthorizationHeader` | Без сохранённой пары открывается при подключении и запуске браузера; с сохранённой парой отключён |
| Chromium | Первый CONNECT контролирует браузер, реквизиты передаются после 407              | Открывается при подключении и запуске даже с сохранёнными реквизитами                             |

Knock host необязателен: его отсутствие не мешает включить профиль и не вызывает предупреждения.
Если он настроен, в фоне откроется обычная HTTPS-вкладка: если реквизитов нет, браузер показывает свой диалог
авторизации. Введённые там пароли остаются в браузере; расширение не читает их и
не копирует в профиль. Поле и кнопка knock в Firefox отключаются, когда сохранены
и логин, и пароль. Сохранённый knock host при этом не удаляется.
После успешного HTTP-ответа и завершения загрузки вкладка knock host автоматически закрывается.
При ошибке загрузки, отмене или неудачной авторизации вкладка остаётся открытой.
Повторные запросы используют уже открытую ожидающую вкладку; её состояние хранится
в storage.session, чтобы закрытие работало и после перезапуска фонового процесса.

В протестированном Firefox отправка в первом CONNECT подтверждена для HTTPS-прокси.
Для HTTP-прокси Firefox может ждать 407; сочетание HTTP-прокси с probe resistance
без challenge на целевом адресе не поддерживается этой логикой. Для такого сервера
используйте HTTPS-прокси. Поле `browser.authMode` сохранено для старых импортов,
но сохранённые реквизиты Firefox всегда запрашивает отправить сразу.

Обработчик `onAuthRequired` отвечает только активному прокси, сверяя host/port и
`isProxy`. Повторный challenge одного запроса отменяется. Реквизиты не добавляются
к заголовкам целевого сайта и не используются для его 401.

Для MegaProxyServer с включённым `probe_resistance` добавьте разрешённое имя в `knock`
на сервере и укажите то же имя в профиле расширения. У этого имени должен быть рабочий
HTTPS-сайт, если хотите видеть успешную загрузку после CONNECT; для получения самого
407 достаточно разрешённого server-side knock hostname. Никакие публичные knock хосты
не выбираются автоматически. Knock не должен входить в исключения. Открытие вкладки
само по себе не является проверкой успешной авторизации. При переключении профилей
браузерный кеш авторизации может потребовать нового knock.

HTTPS здесь означает TLS **до прокси**, независимо от схемы целевого сайта.
HTTP-прокси передаёт Basic реквизиты без TLS на участке до прокси. Сертификаты HTTPS
прокси проверяются; отключение проверки не поддерживается. Используйте сертификат,
которому доверяет браузер.
Домены в исключениях применяются также к поддоменам, без wildcard/PAC.
Firefox возвращает цепочку с завершающим `null`, чтобы запретить прямой fallback.
Chromium использует один fixed proxy.

## Профили и маршрутизация

Профили имеют стабильные ID, цвет, код страны, клонирование и порядок. Порядок меняется
перетаскиванием за ручку мышью или касанием; с клавиатуры — стрелками вверх и вниз на ручке.
Обход локальных
сетей включён по умолчанию и отключается в настройках. Он включает частные IPv4,
loopback, link-local, IPv6 ULA/link-local, localhost и локальные имена. Дополнительные
доменные исключения применяются независимо от переключателя. В Chromium CIDR-правила
работают для IP-литералов URL; частный адрес, скрытый за обычным DNS-именем, не гарантирует
обход. Для такого имени добавьте доменное исключение.

Режим «Все сайты» отправляет запросы через выбранный профиль с учётом исключений.
Настройки маршрутизации сохраняются автоматически: переключатели сразу, текстовые поля при выходе из поля.

Failover можно отключить, использовать все профили или выбранные в заданном порядке.
Переключение происходит при наблюдаемой ошибке соединения с прокси, а не при обычном
HTTP-ответе сайта. IP и страна могут измениться. После исчерпания кандидатов текущий прокси сохраняется;
прямого fallback нет. Ручное подключение начинает новую последовательность попыток.

## Совместимость конфигурации

Общий контракт версии 8, его английская документация, схемы и примеры находятся в
[MegaProxyConfig](https://github.com/andre487/MegaProxyConfig). При сборке из локальной
схемы генерируется CSP-совместимый валидатор: импорт и экспорт версии 8 проверяются
той же схемой, что и тесты. Никаких сетевых запросов за схемой при сборке или тестах нет.

```sh
npm run renew-config-schema
npm run renew-config-schema -- --ref=<полный-commit>
```

Команда обновляет `config-schema/`: обе схемы, лицензию, commit и SHA-256 в lock-файле.
Изменения копий схем и lock-файла нужно проверять и коммитить вместе. Форматтер
исключает этот каталог, чтобы не менять исходные байты и контрольные суммы.

Импортируются MegaProxy JSON, ZeroOmega JSON, FoxyProxy JSON (`https`/`ssl`, `hostname`/`address`),
ProxyList и поддерживаемый Android формат SuperProxy. Поддерживаемые HTTP-профили
также принимаются. SSH, jump-цепочки, PAC и отключение проверки сертификата пропускаются
с предупреждением. URL-правила FoxyProxy не переносятся. Если поля неизвестны или не поддерживаются,
перед применением показывается одно предупреждение «Конфигурация содержит неизвестные
поля». Такие поля не сохраняются и не попадают в экспорт. Максимум файла — 1 МБ,
профилей — 1000. Файлы импорта могут содержать пароли — не коммитьте их.

Перед применением показываются новые, обновляемые и пропускаемые профили. Совпадающие
ID обновляются без дубликатов и изменения местного порядка. Отсутствующий в файле пароль
сохраняется, явная пустая строка очищает его. Отсутствующие локальные профили остаются;
их можно выбрать для удаления. Импорт не подключает указанный в файле активный профиль.
Изменения уже активного профиля применяются после подтверждения импорта.

Экспорт — MegaProxy JSON версии 8. Пароли по умолчанию исключены, для включения есть
отдельный переключатель. Неподдерживаемые Android-поля отбрасываются с общим предупреждением при импорте.
Текущий Android не поддерживает HTTP и IPv6-литералы в поле хоста прокси; экспорт таких
профилей явно отклоняется, без изменения протокола. Android игнорирует новые блоки
`browser`, но при своём экспорте пока удаляет их: полный обратный перенос настроек
расширения через Android потребует сохранения неизвестных полей в приложении.

## Проверка подключения

Проверка использует активный профиль и обычную неактивную вкладку браузера, закрывая
её после завершения. Этапы как в Android: HTTPS-запрос к `example.com`, выходной IP
(`ifconfig.me`, `api.ipify.org`, `icanhazip.com`) и страна (`ifconfig.co`, `ipapi.co`,
`api.country.is`) с fallback между провайдерами. Страна необязательна. Таймаут всего
теста 45 секунд, отдельной попытки — 10 секунд. Исключения для хостов диагностики
запрещают тест, чтобы прямой запрос не выдавался за проверку прокси.

## Линтер и форматирование

[Prettier](https://prettier.io/) — единственный форматтер для JS/MJS, HTML, CSS,
JSON, Markdown и YAML. Настройки в `.prettierrc.json`: 2 пробела, одинарные кавычки,
без лишних точек с запятой, предпочтительная ширина строки 100 символов. Длинные
выражения переносятся автоматически; строковые литералы могут превышать эту ширину.

[ESLint](https://eslint.org/) проверяет JavaScript по рекомендованному набору правил.
Окружения и дополнительные правила находятся в `eslint.config.mjs`, глобальные
переменные расширения — также в комментариях `/* global … */`.
`eslint-config-prettier` отключает правила, конфликтующие с форматтером.
Версии инструментов закреплены в `package.json` и lockfile. Файлы из `.gitignore`
исключены из форматирования; схемы в `config-schema` исключены отдельно, чтобы
сохранить контрольные суммы исходных файлов.

```sh
npm run lint         # ESLint + проверка форматирования Prettier
npm run lint:fix     # Исправления ESLint, затем форматирование Prettier
npm run format       # Форматирование всего проекта Prettier
npm run format:check # Проверка форматирования без изменения файлов
```

В VS Code установите рекомендованные расширения **Prettier** (`esbenp.prettier-vscode`)
и **ESLint** (`dbaeumer.vscode-eslint`). Настройки репозитория включают форматирование
и исправления ESLint при сохранении.

Функции разделяем пустыми строками, внутри функций отделяем логические блоки.
Правило ESLint `curly: all` требует фигурные скобки у всех `if`, `else` и циклов;
Prettier размещает тела блоков на отдельных строках.
Prettier сохраняет пустые строки, но не определяет смысловые границы блоков автоматически.

## Проверки и PR

```sh
# Требуются Docker с запущенным daemon, uv, Git и OpenSSL.
npx playwright install chromium firefox
npm run check
```

В [.github/workflows/pr.yml](.github/workflows/pr.yml) проверки запускаются на каждом PR:

- ESLint: правила качества кода всех JS/MJS-файлов; ошибки и предупреждения блокируют PR.
- Prettier: единое форматирование JS/MJS, HTML/CSS/JSON, Markdown и YAML; отличия блокируют PR.
- Node: валидация, Unicode Basic, маршрутизация, импорт, ограничение повторов и защита реквизитов.
- Playwright Chromium: установленное MV3-расширение, реальный тестовый proxy challenge,
  knock, последующий CONNECT и отсутствие реквизитов на origin.
- Playwright Firefox: установка временного расширения через Mozilla DevTools protocol;
  test-only sidecar в временной копии вызывает штатный background handler (не попадает в сборку). Playwright проверяет настоящие сетевые запросы; его управление `moz-extension` страницами не поддерживается.
- MegaProxyServer: настоящий GOST 3.3.0 и HAProxy в Docker, шаблоны и экспорты из зафиксированного commit сервера; HTTPS/407, маскировка с knock и без него, отдельная настройка маскировки цепочки, прямой маршрут и SNI-цепочка (включая сервер без прямого маршрута), IP-endpoint, неверные/пустые реквизиты, отсутствие утечек реквизитов на origin, отказ выхода без прямого fallback, split proxy, подписки через прокси, диагностика и статистика opt-in.
- Запуск Chrome для разработки: актуальный код при повторном запуске и сохранение языка в отдельном профиле
  (если установлен обычный Chrome).
- UI в Chromium и Firefox: создание/редактирование/удаление, импорт, темы, клавиатура и мобильная ширина;
  автолокализация по языку браузера, ручной выбор и его сохранение, перевод ошибок и сохранение данных формы при переключении.

## Организация кода

`extension/platform.js` содержит общий класс `BrowserPlatform` и реализации
`ChromiumPlatform` и `FirefoxPlatform`. Они отвечают за нативные настройки прокси,
авторизацию и knock, маршрутизацию вкладок, доступные возможности интерфейса и
совместимость импортируемых настроек. Конкретная реализация выбирается при запуске;
общие обработчики и UI вызывают её методы. API браузера и функции ядра передаются
через конструктор, а зависимости отдельных операций — через аргументы, без DI-контейнера.

Перед изменением поведения адаптеров запускайте `npm run check`: юнит-тесты проверяют
пограничные случаи и восстановление настроек, Playwright — реальные Chromium и Firefox,
включая взаимодействие с MegaProxyServer.

## Источники решений

- [AndroidMegaProxy](https://github.com/andre487/AndroidMegaProxy): Basic в первом CONNECT.
- [MegaProxyServer](https://github.com/andre487/MegaProxyServer): JSON-экспорты, SNI chains и knock при probe resistance.
- [FoxyProxy](https://github.com/foxyproxy/browser-extension): сверка proxy challenger и ограничение повторов.
- [Mozilla ProxyInfo](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy/ProxyInfo),
  [proxy.onRequest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy/onRequest),
  [Chrome webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest),
  [Playwright extensions](https://playwright.dev/docs/chrome-extensions).

Код написан для этого репозитория; исходники других расширений не копируются.
Иконка взята из [AndroidMegaProxy](https://github.com/andre487/AndroidMegaProxy/blob/main/fastlane/metadata/android/en-US/images/icon.png)
под MIT; оригинальный PNG и размеры для браузера находятся в `extension/icons`,
лицензия исходного проекта сохранена рядом. Векторного исходника в Android-репозитории нет.
Для панели браузера используются отдельные PNG со скруглёнными прозрачными углами
в размерах 16, 24, 32 и 48 px. Для их пересоздания из оригинального логотипа:
`node scripts/renew-toolbar-icons.mjs` (нужен установленный Playwright Chromium).

## Selective routing

Selective routing is disabled by default, keeping all eligible requests on the
active proxy. In settings, enable it and enter one hostname pattern per line.
Exact hostnames match only themselves; `*` matches any characters, including dots.
For example, `*.example.com` selects subdomains, not `example.com`. Empty lists
connect directly. Both modes respect local-network and profile bypass rules.

- **Destination domains (Chromium and Firefox):** only requests whose destination
  hostname matches the domain list use the proxy.
- **Split proxy by tab (Firefox):** tabs whose top-level hostname matches the site
  list use the proxy for their attributed requests, including resources on other
  domains. Requests without a tab go directly. The popup can override the current
  tab and reload it; the override lasts until the tab closes or routing settings
  change. Previously opened connections are not migrated.

The popup's **Proxy this site** action adds the current hostname to the current
mode's list, enables selective routing and reloads that tab. Chromium hides the
mode selector and manual tab controls. Chromium PAC routing always bypasses
localhost and link-local addresses; disabling local bypass cannot override this
browser restriction in selective mode. Other local ranges can still be proxied.
Required knock traffic and connection checks use the active proxy independently
of the saved inclusion lists.

Both modes export under `browser.routing` (`enabled`, `mode`, `domains`, `sites`)
without browser tab IDs or manual overrides. Importing Firefox `tabs` mode in
Chromium shows an explicit compatibility warning, discards the `sites` list and
uses destination-domain routing with the imported `domains` list. The extension
does not reinterpret tab site patterns as destination domains. The new browser
fields remain optional and compatible with Android's version 8 configuration.

## Подписки на доменные списки Podkop

В «Выборочном проксировании» можно выбрать готовые доменные списки из
[itdoginfo/allow-domains](https://github.com/itdoginfo/allow-domains). Подписки для
режима по доменам и Firefox split proxy выбираются независимо. Настройки нужно
сохранить; обновление запускается кнопкой или автоматически раз в сутки при
работающем браузере. После ошибки повторная попытка выполняется через час.
Опция «Обновлять списки через активный прокси» использует выбранный профиль,
даже в выборочном режиме. Без активного профиля будет ошибка, без прямого fallback.
При выключенной опции загрузки выполняются без прокси MegaProxy.

Берутся только DNS-имена: IP, CIDR и другие форматы пропускаются. Домен вместе со
всеми поддоменами хранится одной записью `**.example.com`. Она совпадает и с
`example.com`, и с `a.b.example.com`, но не с `notexample.com`. Прежний
`*.example.com` по-прежнему означает только поддомены. Дубликаты и записи,
перекрытые присутствующим в списке родителем, удаляются. Родительский домен,
которого нет в источнике, не добавляется: `a.example.com` не расширяется до
`example.com`. Ручные правила остаются отдельными.

Лимит — 1000 действующих правил на режим. Сначала сохраняются все ручные правила,
затем правила подписок по рейтингу [Tranco](https://tranco-list.eu/). Рейтинг
скачивается только при необходимости обрезки: основной источник — ежедневное
[GitHub-зеркало](https://github.com/wangmm001/tranco-top1m-cache), резервный —
официальный сайт Tranco. Учитывается точный домен или ближайший родитель с
известным рейтингом. Это приблизительная глобальная популярность, а не измерение
личных предпочтений. Домены без рейтинга идут после ранжированных по алфавиту;
отсутствие рейтинга не означает непопулярность. При недоступности рейтинга
используются сохранённые оценки или алфавитный порядок, с явным предупреждением.

Интерфейс показывает число отброшенных правил: такие домены идут напрямую,
если их не покрывает другое правило. Ошибка загрузки любого выбранного источника
сохраняет последнюю успешную версию целиком. Ограничения скачивания: 4 MiB и
200 000 строк на доменный список; 32 MiB после распаковки рейтинга; 30 секунд на
запрос. Списки и оценки кэшируются локально; история посещений никуда не отправляется.
Сопоставление рейтинга и правил выполняется при обновлении, а не на каждом запросе.

Настройки подписок находятся в `browser.routing.subscriptions` и входят в экспорт;
кэш, рейтинг, ошибки и время загрузки не экспортируются. После импорта нужно
обновить списки; при включённом автообновлении это происходит автоматически.
Chromium явно предупреждает и отбрасывает правила вкладок и `siteSources`, даже
если импортируемый Firefox-конфиг сейчас использует режим по доменам.

Chromium временно применяет настройки для хостов источников во время загрузки;
это влияет и на другие запросы к этим хостам и включает неотключаемый PAC-обход
localhost/link-local. После загрузки, включая ошибку, прежняя маршрутизация
восстанавливается. В Firefox выбор транспорта касается фоновых загрузок
расширения.

Tranco: Victor Le Pochat et al. (2019), _Tranco: A Research-Oriented Top Sites
Ranking Hardened Against Manipulation_, NDSS,
[doi:10.14722/ndss.2019.23386](https://doi.org/10.14722/ndss.2019.23386).

### Optional request statistics

Statistics and network monitoring are enabled by default, with one local opt-out in Settings. Existing saved opt-out preferences remain respected. Counters track completed and failed MegaProxy requests. Direct requests are excluded. Statistics remain local in the browser and are never sent anywhere. Counters stay in memory, reset on opt-out or background-process restart, and never write storage per request. The statistics panel refreshes every five seconds only while its page is visible and statistics are enabled. Opting out removes the collecting listeners, clears the journal and counters, and hides both panels. The preference is local and is neither imported nor exported; no traffic-volume measurement is attempted.

### Server integration tests

`npm run test:e2e` prepares the pinned MegaProxyServer checkout, its locked Python dependencies (using uv), and Docker images before running all Playwright tests. GitHub Actions runs this on every PR and push to `main`, and retains Playwright traces and server logs on failure. No remote server is provisioned: each test creates and removes its own Docker network, GOST entry/exit servers, HAProxy frontend, origin, certificates and browser profiles.

Versions are pinned in `tests/megaproxy-server/versions.json`. To run only these tests locally:

```sh
npm run build
npm run prepare:server-e2e
npx playwright test tests/server.spec.mjs
```

The fixture renders the server's actual GOST and HAProxy templates and invokes its exporter for MegaProxy JSON, FoxyProxy JSON, ProxyList and SuperProxy. A test CA replaces ACME issuance; browser certificate exceptions are confined to isolated test profiles. The GOST chain validates the exit certificate against that CA. These are client interoperability tests, not Ansible provisioning or ACME renewal tests. SSH/SSH_JUMP profiles and unsafe self-signed-certificate flags are checked for rejection because the extension cannot implement SSH forwarding.

The native proxy credential dialog is outside Playwright’s page API: tests verify that the browser opens a knock tab and the real server challenges it, but do not automate typing into that dialog.

## WebRTC, sync and routing tools

Settings provide browser-wide native WebRTC privacy controls. Chromium and Firefox
can restrict interfaces and non-proxied UDP; Firefox can additionally disable
WebRTC or require proxy-only TURN connections. The optional `privacy` permission
is requested when selecting a controlled policy. “Use browser settings” releases
MegaProxy's control. These preferences affect direct sites too and may affect calls.

Browser sync and password sync are enabled by default, with separate opt-out
controls. `storage.sync` uses the browser's configured account and sync service;
the extension cannot reliably detect whether account sync is configured. It
reads an existing remote snapshot before publishing local profiles on startup.
The active connection, request statistics, downloaded lists and granted permissions
remain local. Password opt-out excludes passwords from incoming and outgoing
snapshots and retains existing local passwords. Complete snapshots use revisioned
chunks; the last published configuration wins. The 45,000-byte payload limit leaves
room for both old and new snapshots within browser quotas. Failures preserve local
settings and appear in the sync status. HTTP, HTTPS and IPv6 profiles are supported
by sync independently of the portable Android export's stricter protocol limits.

The context menu offers connect/disconnect, proxy the current site (including
subdomains), exclude the current site, settings, and Firefox split-tab toggle.
No keyboard shortcuts are registered. The routing tester evaluates saved rules
without making a network request; specify a tab URL to test third-party resources
in split-proxy mode. URL import accepts HTTP(S), downloads at most 1 MiB with a
30-second timeout, and uses the same validation, review and warnings as file import.

Selective routing uses one selected profile in both browsers. Matching destination domains
(or matching top-level sites in Firefox tab mode) use that profile; other traffic goes DIRECT.
Local/profile bypass and Firefox manual DIRECT tab choices take precedence.
Legacy per-domain profile assignments are ignored on import with a general warning.
Their existing domain lists are retained; an obsolete `profiles` strategy becomes `manual`.
Stored configurations and synchronized preferences receive the same normalization.

We deliberately retain one global active profile. SOCKS/QUIC, user PAC files,
container/private-window profiles, regular expressions and full-URL routing,
request logs, automatic backups, enterprise policies and bulk editing are outside
the scope of this client. New unit and Playwright scenarios run in the existing
GitHub PR workflow. Browser-account cloud transport is not automated: tests cover
the storage API protocol, opt-out, malformed snapshots and quota failures locally.

In Chromium, a successful knock (HTTP 2xx/3xx on its main page) schedules a
one-time refresh for HTTP(S) tabs that were already open when knock started and
are routed through the active proxy. They reload only when activated. Direct,
extension/browser and already-discarded tabs are excluded. Navigating elsewhere
or closing a tab removes its marker; a failed knock does not schedule refreshes.
Markers remain local in `storage.session`, survive service-worker suspension,
and are cleared with the browser session. Firefox does not use this behavior.

## Direct, System and network monitoring

The popup and the top of Settings provide Proxy, Direct and System modes.
The choice updates across all open extension pages through local browser storage.
The selected profile remains selected when requests fail; there is no automatic
profile switching. Legacy Fallback mode migrates to Proxy without changing the
selected profile. Direct forces requests to connect without a proxy. System releases
MegaProxy's control and uses existing browser/system proxy settings. Disconnect
selects System. The connection mode stays local and is not synchronized or exported.
Configs containing the unsupported `failover` field show the unknown-fields warning;
that field is ignored and omitted from exports.

Selective routing chooses between the active profile and DIRECT. It never selects
another profile based on a domain. Browser authentication caches are tied to proxy
endpoints; use distinct endpoints for different credentials.

The icon shows the profile selected for the tab's top-level URL on a colored plate,
with long names fading out at the right edge and the full name in its tooltip.
Internal browser/extension pages show the active profile. Direct/System use DIR/SYS. Third-party resources follow the selected routing mode; their routes appear in the monitor.
System means browser-managed routing, whose external proxy is not inferred.
Badge updates run on navigation, activation and configuration changes rather
than every resource request.

The network monitor in Settings lists recent HTTP(S) resources, optionally
filtered to failures (network errors or HTTP status >= 400). Select failed
domains and add them to the active manual domain list or Firefox tab-site list.
The action is hidden in other routing modes and does not switch modes. Data stays in memory and is never sent
anywhere. Only hostname, resource type, status/error, selected profile and time
are retained, without URL paths, query strings, headers, bodies or credentials.
Limits are 200 rows per tab and 50 tabs. Navigation, tab close, opt-out and
background restart clear their relevant entries. The journal has no per-request
storage writes, UI messages or badge changes. Refresh runs every five seconds
only while the monitor is open and visible.

## ZeroOmega import compatibility

Import accepts ZeroOmega/SwitchyOmega settings JSON (`schemaVersion` 1 or 2,
`+name` profiles), from files or the existing config URL importer. It transfers
compatible HTTP/HTTPS fixed profiles, credentials, simple hostname bypasses,
virtual-profile references and a selected switch profile's hostname rules.
`*.example.com` becomes an apex-and-subdomains domain rule; exact hostnames remain
exact. Per-domain profile choices are not imported and produce a review warning. Imported settings never activate a profile.
A knock host is optional.

SOCKS, user PAC, downloaded rule lists, regex/full-URL/time conditions, unequal
per-protocol endpoints or credentials, multiple switch trees and incompatible
rule ordering produce review warnings or skipped profiles. A fixed switch
default cannot activate a local connection automatically and is warned about.
Unsupported settings are not retained. Arbitrary subscription URLs, user PAC
scripts and a separate startup-profile selector remain deliberately out of scope.

### Dynamic community-list catalog

The available domain lists are discovered from the `itdoginfo/allow-domains`
GitHub file tree. Services, categories and regional raw lists are supported;
IP/subnet and generated non-domain formats are excluded. Existing source IDs
remain stable. A generated bundled snapshot keeps the UI usable offline; renew
it with `npm run renew-list-catalog` before a release.

The catalog refreshes daily alongside subscriptions, even when no lists are
selected, and follows the same direct/proxy update preference. Failed catalog
refreshes retain the last successful data. Missing selected IDs stay visible and
are preserved on save/import; a failed list update preserves the previous rules.
Coverage warnings compare the selected source lists with hostname-suffix semantics
before popularity truncation, independently for domain and Firefox tab modes.
Downloads use at most four concurrent requests; source lists are not retained in
storage. The local catalog and coverage cache are not exported or synchronized.

Until the updated schema is published in MegaProxyConfig, `renew-config-schema`
applies the dynamic-ID and routing-strategy additions from `scripts/config-schema-overrides.mjs`.
`schema-lock.json` records both original upstream and effective local checksums.
The matching schema and English contract documentation are prepared in the local
MegaProxyConfig checkout.

The settings page uses native dialogs for profile editing and URL imports.
A single mode selector shows the controls for manual domain rules, automatic
lists or Firefox tabs. Inactive settings
are preserved, but only the selected strategy affects routing. The optional
`browser.routing.strategy` is exported and synchronized; omitting it preserves
legacy combined routing. The connection check is available at the top for Proxy, Direct and
System; the footer shows the package version and Git commit (`+dirty` for
modified working trees). Chromium defaults to dark and offers explicit light/dark
themes; old `system` preferences migrate to dark. Firefox also supports automatic
appearance via `prefers-color-scheme`.

The popup fits 320px mobile screens and stays centered when opened as a browser
tab. Dialogs and forms reflow on narrow screens; controls use larger touch targets
for coarse pointers. Modern desktop browsers supporting `appearance: base-select`
use a CSS-styled native picker anchored to its control. Touch devices and browsers
without that support keep their platform picker.
