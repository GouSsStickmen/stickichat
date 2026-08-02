# Політика підпису коду · Code Signing Policy

**StickiChat** · https://github.com/GouSsStickmen/stickichat

---

## Українською

### Хто підписує

Релізи StickiChat підписуються безкоштовно організацією
[SignPath Foundation](https://signpath.org/) сертифікатом, виданим на неї як на видавця.
Сертифікат надано в межах програми підтримки проєктів з відкритим кодом.

### Що саме підписується

Підписується інсталятор для Windows `StickiChat-Setup-<версія>.exe` та виконувані файли
всередині нього. Інсталятори публікуються лише на сторінці
[GitHub Releases](https://github.com/GouSsStickmen/stickichat/releases) цього репозиторію.
Жодні інші канали розповсюдження не є офіційними.

### Ролі

| Роль | Хто |
| --- | --- |
| Автор (Author) | GouS_Stickmen — власник репозиторію |
| Рецензент (Reviewer) | GouS_Stickmen |
| Затверджувач (Approver) | GouS_Stickmen |

Проєкт наразі веде один розробник, тому всі ролі виконує одна особа. Якщо до проєкту
долучаться інші учасники, ролі буде розділено, і цей документ оновлять.

### Захист облікових записів

Усі облікові записи, що мають доступ до репозиторію та до конвеєра підпису, мають
увімкнену **двофакторну автентифікацію (2FA)**.

### Як збираються бінарники

Реліз збирається з коду цього репозиторію командою:

```
npm run release
```

що виконує `electron-vite build` (збірка з вихідних кодів) і `electron-builder --win --publish always`
(створення інсталятора та публікація в GitHub Releases). Кожен реліз відповідає комітові в
гілці `main` з піднятою версією в `package.json`.

### Приватність

StickiChat не збирає й не передає телеметрію. Застосунок звертається лише до:
Twitch (IRC, Helix, EventSub, PubSub, публічний GQL), 7TV, BetterTTV, FrankerFaceZ,
сервісу оновлень на GitHub, і — за запитом користувача — до сайтів, на які він відкриває
прев'ю посилань. Облікові дані Twitch зберігаються локально на пристрої користувача,
зашифровані засобами ОС.

### Зворотний зв'язок

Про підозрілу або непідписану збірку повідомляйте через
[Issues](https://github.com/GouSsStickmen/stickichat/issues).

---

## English

### Who signs

StickiChat releases are signed free of charge by the
[SignPath Foundation](https://signpath.org/) with a certificate issued to the Foundation as
the publisher, under its support programme for open-source projects.

### What is signed

The Windows installer `StickiChat-Setup-<version>.exe` and the executables it contains.
Installers are published **only** on this repository's
[GitHub Releases](https://github.com/GouSsStickmen/stickichat/releases) page. No other
distribution channel is official.

### Roles

| Role | Person |
| --- | --- |
| Author | GouS_Stickmen — repository owner |
| Reviewer | GouS_Stickmen |
| Approver | GouS_Stickmen |

The project currently has a single maintainer, so one person holds all roles. Should further
contributors join, the roles will be separated and this document updated.

### Account protection

All accounts with access to the repository and to the signing pipeline have
**two-factor authentication (2FA)** enabled.

### How binaries are built

Releases are built from the source in this repository with:

```
npm run release
```

which runs `electron-vite build` (a build from source) followed by
`electron-builder --win --publish always` (installer creation and publication to GitHub
Releases). Every release corresponds to a commit on `main` with a bumped version in
`package.json`.

### Privacy

StickiChat collects and transmits no telemetry. It contacts only Twitch (IRC, Helix,
EventSub, PubSub, public GQL), 7TV, BetterTTV, FrankerFaceZ, the GitHub update feed, and —
at the user's request — sites for which link previews are opened. Twitch credentials are
stored locally on the user's machine, encrypted with OS facilities.

### Reporting

Report a suspicious or unsigned build via
[Issues](https://github.com/GouSsStickmen/stickichat/issues).
