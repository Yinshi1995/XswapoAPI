<p align="center">
  <img src="https://img.shields.io/badge/Bun-1.1-black?logo=bun&logoColor=white" alt="Bun" />
  <img src="https://img.shields.io/badge/GraphQL-Yoga-E535AB?logo=graphql&logoColor=white" alt="GraphQL Yoga" />
  <img src="https://img.shields.io/badge/Prisma-6-2D3748?logo=prisma&logoColor=white" alt="Prisma" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/PostgreSQL-336791?logo=postgresql&logoColor=white" alt="PostgreSQL" />
</p>

# ⚡ XSwapo API

> Client-facing GraphQL API для криптообменного сервиса XSwapo.
> Предоставляет клиентам доступ к списку монет, расчёту курсов, лимитам и созданию заявок на обмен.

---

## 📋 Содержание

- [Стек технологий](#-стек-технологий)
- [Архитектура](#-архитектура)
- [Быстрый старт](#-быстрый-старт)
- [Переменные окружения](#-переменные-окружения)
- [GraphQL API](#-graphql-api)
  - [Queries](#queries)
  - [Mutations](#mutations)
- [Примеры запросов](#-примеры-запросов)
- [Структура проекта](#-структура-проекта)
- [Бизнес-логика](#-бизнес-логика)

---

## 🛠 Стек технологий

| Технология | Назначение |
|:--|:--|
| [Bun](https://bun.sh) | JavaScript/TypeScript runtime + HTTP сервер |
| [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) | GraphQL сервер (SDL-first) |
| [Prisma 6](https://www.prisma.io) | ORM для PostgreSQL |
| [TypeScript 5](https://www.typescriptlang.org) | Типизация |
| [Binance API](https://binance-docs.github.io/apidocs/) | Источник обменных курсов |

---

## 🏗 Архитектура

```
┌─────────────┐     GraphQL      ┌──────────────┐     Prisma     ┌────────────┐
│   Клиент    │ ──────────────── │  XSwapo API  │ ─────────────  │ PostgreSQL │
│  (фронт /   │   /graphql       │  (Bun +      │                │            │
│   мобайл)   │                  │   Yoga)      │                │  (shared   │
└─────────────┘                  └──────┬───────┘                │   с admin) │
                                        │                        └────────────┘
                                        │ fetch
                                        ▼
                                 ┌──────────────┐
                                 │  Binance API │
                                 │  (spot rate) │
                                 └──────────────┘
```

API и Admin-панель работают с **одной и той же PostgreSQL базой** через идентичную Prisma-схему.

---

## 🚀 Быстрый старт

### Требования

- [Bun](https://bun.sh) ≥ 1.1
- PostgreSQL ≥ 14
- Существующая база данных (та же, что у Admin-панели)

### Установка

```bash
# Клонировать репозиторий
git clone <repo-url>
cd api

# Установить зависимости
bun install

# Создать .env файл
cp .env.example .env
# Отредактировать DATABASE_URL в .env

# Сгенерировать Prisma Client
bunx prisma generate

# Запустить сервер
bun run index.ts
```

Сервер стартует на `http://localhost:4000/graphql` с интерактивным GraphQL Playground.

---

## 🔐 Переменные окружения

| Переменная | Описание | По умолчанию |
|:--|:--|:--|
| `DATABASE_URL` | PostgreSQL connection string | — (обязательно) |
| `PORT` | Порт HTTP сервера | `4000` |

Пример `.env`:
```env
DATABASE_URL="postgresql://user:password@localhost:5432/xswapo"
PORT=4000
```

---

## 📡 GraphQL API

### Endpoint

```
POST http://localhost:4000/graphql
```

Заголовки:
```
Content-Type: application/json
X-Api-Key: <your-api-key>       # опциональный, для привязки к партнёру
```

---

### Queries

#### `coins` — Список всех активных монет

Возвращает активные монеты со списком доступных сетей.

```graphql
query {
  coins {
    id
    code
    name
    imageUrl
    minDepositAmount
    maxDepositAmount
    networks {
      network {
        code
        name
        chain
        isDepositEnabled
        isWithdrawEnabled
        explorerUrl
      }
      contractAddress
      decimals
      depositEnabled
      withdrawEnabled
    }
  }
}
```

---

#### `coin(code)` — Получить монету по коду

```graphql
query {
  coin(code: "BTC") {
    code
    name
    imageUrl
    networks {
      network { code name }
      depositEnabled
      withdrawEnabled
    }
  }
}
```

---

#### `limits(coinCode)` — Лимиты на обмен

```graphql
query {
  limits(coinCode: "BTC") {
    coinCode
    minAmount
    maxAmount
  }
}
```

---

#### `rate(input)` — Расчёт курса обмена

Рассчитывает курс, итоговую сумму и комиссию на основе Binance spot price.

```graphql
query {
  rate(input: {
    from: "BTC"
    to: "ETH"
    amount: "0.1"
    fromNetwork: "BTC"
    toNetwork: "ETH"
  }) {
    result       # сколько получит пользователь
    amount       # исходная сумма
    rate         # курс обмена
    feeAmount    # комиссия
    minAmount    # мин. сумма для обмена
    maxAmount    # макс. сумма для обмена
  }
}
```

---

#### `exchangeRequest(id)` — Получить заявку по ID

```graphql
query {
  exchangeRequest(id: "clxyz...") {
    id
    status
    fromCoin { code name }
    fromNetwork { code name }
    toCoin { code name }
    toNetwork { code name }
    fromAmount
    toAmount
    receivedAmount
    estimatedRate
    feeAmount
    depositAddress { address }
    clientWithdrawAddress
    createdAt
    completedAt
    transactions {
      id
      type
      status
      amount
      txHash
      confirmedAt
    }
  }
}
```

---

#### `exchangeRequests(page, pageSize, status)` — Список заявок

```graphql
query {
  exchangeRequests(page: 1, pageSize: 10, status: COMPLETED) {
    edges {
      node {
        id
        status
        fromCoin { code }
        toCoin { code }
        fromAmount
        toAmount
        createdAt
      }
    }
    pageInfo {
      currentPage
      totalPages
      totalCount
      hasNextPage
    }
  }
}
```

---

### Mutations

#### `createExchangeRequest(input)` — Создать заявку на обмен

Валидирует монеты/сети, проверяет лимиты, рассчитывает курс и комиссию, создаёт депозитный адрес и заявку в одной транзакции.

```graphql
mutation {
  createExchangeRequest(input: {
    from: "BTC"
    fromNetwork: "BTC"
    to: "ETH"
    toNetwork: "ETH"
    amount: "0.1"
    address: "0xAbCdEf..."
  }) {
    id
    status
    fromAmount
    toAmount
    estimatedRate
    feeAmount
    depositAddress { address }
    createdAt
  }
}
```

---

## 📁 Структура проекта

```
api/
├── index.ts                          # Точка входа — Bun HTTP + GraphQL Yoga
├── package.json
├── tsconfig.json
│
├── prisma/
│   └── schema.prisma                 # Prisma-схема (зеркало admin DB)
│
└── src/
    ├── schema.ts                     # GraphQL SDL — типы, inputs, queries, mutations
    ├── context.ts                    # Тип контекста (prisma + apiKey)
    │
    ├── lib/
    │   └── prisma.ts                 # Prisma Client singleton
    │
    └── resolvers/
        ├── index.ts                  # Объединение резолверов + кастомные скаляры
        ├── queries.ts                # coins, coin, limits, rate, exchangeRequest(s)
        └── mutations.ts              # createExchangeRequest
```

---

## 💡 Бизнес-логика

### Расчёт курса

1. Запрос к Binance `GET /api/v3/ticker/price`
2. Пробуются пары в порядке: **прямая** (`BTCETH`) → **инвертированная** (`ETHBTC`) → **через USDT** (`BTCUSDT` / `ETHUSDT`)
3. К исходной сумме применяется `floatFeePercent` из настроек монеты
4. Если комиссия < `minimumFee`, используется минимальная
5. Результат: `(amount - fee) × rate`

### Создание заявки

```
Валидация монет и сетей
  └─ Проверка CoinNetworkMapping (depositEnabled / withdrawEnabled)
      └─ Валидация суммы (min/max лимиты)
          └─ Расчёт курса через Binance
              └─ Поиск активного MasterWallet
                  └─ DB Transaction:
                      ├─ Инкремент индекса MasterWallet
                      ├─ Создание DepositAddress
                      └─ Создание ExchangeRequest
```

### Статусы заявки

```
CREATED → WAITING_DEPOSIT → DEPOSIT_DETECTED → PROCESSING → COMPLETED
                                  │
                                  ├─ UNDERPAID → REFUND_PENDING → REFUNDED
                                  ├─ OVERPAID → PARTIALLY_REFUNDED
                                  └─ FAILED / CANCELLED
```

---

## 📄 Лицензия

Proprietary — © XSwapo
