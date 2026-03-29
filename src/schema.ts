export const typeDefs = /* GraphQL */ `
  scalar Decimal
  scalar DateTime

  # ──────────────────────────── Enums ────────────────────────────

  enum ExchangeRequestStatus {
    CREATED
    WAITING_DEPOSIT
    DEPOSIT_DETECTED
    UNDERPAID
    OVERPAID
    REFUND_PENDING
    PARTIALLY_REFUNDED
    REFUNDED
    PROCESSING
    COMPLETED
    CANCELLED
    FAILED
  }

  enum TransactionStatus {
    CREATED
    DETECTED
    PENDING
    BROADCASTED
    CONFIRMED
    FAILED
    CANCELLED
  }

  enum TransactionType {
    CLIENT_DEPOSIT
    CLIENT_REFUND
    TRANSFER_TO_BINANCE
    CLIENT_PAYOUT
    GAS_TOPUP
  }

  # ──────────────────────────── Types ────────────────────────────

  type CoinNetwork {
    code: String!
    name: String!
    depositEnabled: Boolean!
    withdrawEnabled: Boolean!
  }

  type Coin {
    code: String!
    name: String!
    minDepositAmount: Decimal!
    maxDepositAmount: Decimal
    networks: [CoinNetwork!]!
  }

  type CoinLimits {
    coinCode: String!
    minAmount: Decimal!
    maxAmount: Decimal
  }

  type RateResult {
    """Amount of the conversion result (how much the user receives)"""
    result: Decimal!
    """Source amount"""
    amount: Decimal!
    """Exchange rate"""
    rate: Decimal!
    """Minimum exchange amount for the source coin"""
    minAmount: Decimal!
    """Maximum exchange amount for the source coin"""
    maxAmount: Decimal
    """Fee charged"""
    feeAmount: Decimal!
  }

  type TransactionInfo {
    type: TransactionType!
    status: TransactionStatus!
    amount: Decimal!
    txHash: String
  }

  type ExchangeSide {
    coin: String!
    network: String!
    amount: Decimal!
  }

  type ExchangeRequest {
    id: String!
    status: ExchangeRequestStatus!
    createdAt: DateTime!
    from: ExchangeSide!
    to: ExchangeSide!
    rate: Decimal
    fee: Decimal!
    depositAddress: String
    withdrawAddress: String!
    transactions: [TransactionInfo!]!
  }

  type ExchangeRequestEdge {
    node: ExchangeRequest!
  }

  type PageInfo {
    currentPage: Int!
    totalPages: Int!
    totalCount: Int!
    hasNextPage: Boolean!
  }

  type ExchangeRequestConnection {
    edges: [ExchangeRequestEdge!]!
    pageInfo: PageInfo!
  }

  # ──────────────────────────── Inputs ───────────────────────────

  input RateInput {
    """Source coin code (e.g. BTC)"""
    from: String!
    """Destination coin code (e.g. ETH)"""
    to: String!
    """Amount to exchange"""
    amount: Decimal!
    """Source network code (e.g. BTC)"""
    fromNetwork: String!
    """Destination network code (e.g. ETH)"""
    toNetwork: String!
  }

  input CreateExchangeRequestInput {
    """Source coin code (e.g. BTC)"""
    from: String!
    """Source network code"""
    fromNetwork: String!
    """Destination coin code (e.g. ETH)"""
    to: String!
    """Destination network code"""
    toNetwork: String!
    """Amount to exchange"""
    amount: Decimal!
    """Recipient wallet address"""
    address: String!
  }

  # ──────────────────────────── Queries ──────────────────────────

  type Query {
    """List all active coins with their available networks"""
    coins: [Coin!]!

    """Get a single coin by code"""
    coin(code: String!): Coin

    """Get min/max exchange limits for a specific coin"""
    limits(coinCode: String!): CoinLimits

    """Get the current exchange rate between two coins"""
    rate(input: RateInput!): RateResult

    """Get an exchange request by ID"""
    exchangeRequest(id: String!): ExchangeRequest

    """List exchange requests (paginated)"""
    exchangeRequests(
      page: Int = 1
      pageSize: Int = 20
      status: ExchangeRequestStatus
    ): ExchangeRequestConnection!
  }

  # ──────────────────────────── Mutations ────────────────────────

  type Mutation {
    """Create a new exchange request (order)"""
    createExchangeRequest(input: CreateExchangeRequestInput!): ExchangeRequest!
  }
`
