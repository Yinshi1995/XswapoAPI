import { Prisma } from "@prisma/client"
type Decimal = Prisma.Decimal
import type { GraphQLContext } from "../context"
import { resolveNetwork } from "../lib/resolveNetwork"

export const queryResolvers = {
  Query: {
    /**
     * List all active coins with their active network mappings.
     * Mirrors Swapuz GET /api/home/v1/coins
     */
    coins: async (_parent: unknown, _args: unknown, ctx: GraphQLContext) => {
      return ctx.prisma.coin.findMany({
        where: { status: "ACTIVE" },
        include: {
          mappings: {
            where: { isActive: true },
            include: { network: true },
          },
        },
        orderBy: { name: "asc" },
      })
    },

    /**
     * Get a single coin by code.
     */
    coin: async (_parent: unknown, args: { code: string }, ctx: GraphQLContext) => {
      return ctx.prisma.coin.findFirst({
        where: { code: args.code, status: "ACTIVE" },
        include: {
          mappings: {
            where: { isActive: true },
            include: { network: true },
          },
        },
      })
    },

    /**
     * Get exchange limits for a coin.
     * Mirrors Swapuz GET /api/home/getLimits?coin=BTC
     */
    limits: async (_parent: unknown, args: { coinCode: string }, ctx: GraphQLContext) => {
      const coin = await ctx.prisma.coin.findUnique({
        where: { code: args.coinCode },
      })
      if (!coin) return null

      return {
        coinCode: coin.code,
        minAmount: coin.minDepositAmount,
        maxAmount: coin.maxDepositAmount,
      }
    },

    /**
     * Calculate exchange rate between two coins.
     * Mirrors Swapuz GET /api/home/v1/rate
     *
     * Rate logic:
     *  - Uses Binance spot price as base rate
     *  - Applies float fee from the source coin
     *  - Returns the net amount the user would receive
     */
    rate: async (
      _parent: unknown,
      args: { input: { from: string; to: string; amount: string; fromNetwork: string; toNetwork: string } },
      ctx: GraphQLContext,
    ) => {
      const { from, to, amount, fromNetwork, toNetwork } = args.input

      // Validate coins exist and are active
      const [fromCoin, toCoin] = await Promise.all([
        ctx.prisma.coin.findFirst({ where: { code: from, status: "ACTIVE" } }),
        ctx.prisma.coin.findFirst({ where: { code: to, status: "ACTIVE" } }),
      ])
      if (!fromCoin) throw new Error(`Coin ${from} not found or inactive`)
      if (!toCoin) throw new Error(`Coin ${to} not found or inactive`)

      // Validate networks
      const [fromNet, toNet] = await Promise.all([
        resolveNetwork(ctx.prisma, fromNetwork),
        resolveNetwork(ctx.prisma, toNetwork),
      ])
      if (!fromNet) throw new Error(`Network ${fromNetwork} not found or inactive`)
      if (!toNet) throw new Error(`Network ${toNetwork} not found or inactive`)

      // Validate coin-network mappings exist
      const [fromMapping, toMapping] = await Promise.all([
        ctx.prisma.coinNetworkMapping.findUnique({
          where: { coinId_networkId: { coinId: fromCoin.id, networkId: fromNet.id } },
        }),
        ctx.prisma.coinNetworkMapping.findUnique({
          where: { coinId_networkId: { coinId: toCoin.id, networkId: toNet.id } },
        }),
      ])
      if (!fromMapping?.isActive) throw new Error(`${from} is not available on ${fromNetwork}`)
      if (!toMapping?.isActive) throw new Error(`${to} is not available on ${toNetwork}`)

      // Get rate from Binance
      const rate = await getBinanceRate(fromCoin.code, toCoin.code)

      const inputAmount = new Prisma.Decimal(amount)

      // Validate limits
      if (inputAmount.lt(fromCoin.minDepositAmount)) {
        throw new Error(`Amount below minimum of ${fromCoin.minDepositAmount} ${from}`)
      }
      if (fromCoin.maxDepositAmount && inputAmount.gt(fromCoin.maxDepositAmount)) {
        throw new Error(`Amount above maximum of ${fromCoin.maxDepositAmount} ${from}`)
      }

      // Calculate fee (float fee %)
      const feePercent = fromCoin.floatFeePercent
      const feeAmount = inputAmount.mul(feePercent).div(100)
      const effectiveAmount = inputAmount.minus(feeAmount)

      // Ensure fee is at least the minimum
      const actualFee = feeAmount.lt(fromCoin.minimumFee) ? fromCoin.minimumFee : feeAmount
      const finalEffectiveAmount = inputAmount.minus(actualFee)

      // Calculate result
      const result = finalEffectiveAmount.mul(rate)

      return {
        result,
        amount: inputAmount,
        rate: new Prisma.Decimal(rate.toString()),
        minAmount: fromCoin.minDepositAmount,
        maxAmount: fromCoin.maxDepositAmount,
        feeAmount: actualFee,
      }
    },

    /**
     * Get a single exchange request by ID.
     * Mirrors Swapuz GET /api/order/uid/{uid}
     */
    exchangeRequest: async (_parent: unknown, args: { id: string }, ctx: GraphQLContext) => {
      return ctx.prisma.exchangeRequest.findUnique({
        where: { id: args.id },
        include: {
          fromCoin: {
            include: { mappings: { where: { isActive: true }, include: { network: true } } },
          },
          toCoin: {
            include: { mappings: { where: { isActive: true }, include: { network: true } } },
          },
          fromNetwork: true,
          toNetwork: true,
          depositAddress: true,
          transactions: {
            orderBy: { createdAt: "desc" },
          },
        },
      })
    },

    /**
     * List exchange requests with pagination.
     * Mirrors Swapuz GET /api/partner/partnerPaginator
     */
    exchangeRequests: async (
      _parent: unknown,
      args: { page?: number; pageSize?: number; status?: string },
      ctx: GraphQLContext,
    ) => {
      const page = Math.max(1, args.page ?? 1)
      const pageSize = Math.min(100, Math.max(1, args.pageSize ?? 20))
      const skip = (page - 1) * pageSize

      const where = args.status ? { status: args.status as any } : {}

      const [items, totalCount] = await Promise.all([
        ctx.prisma.exchangeRequest.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { createdAt: "desc" },
          include: {
            fromCoin: {
              include: { mappings: { where: { isActive: true }, include: { network: true } } },
            },
            toCoin: {
              include: { mappings: { where: { isActive: true }, include: { network: true } } },
            },
            fromNetwork: true,
            toNetwork: true,
            depositAddress: true,
            transactions: {
              orderBy: { createdAt: "desc" },
            },
          },
        }),
        ctx.prisma.exchangeRequest.count({ where }),
      ])

      const totalPages = Math.ceil(totalCount / pageSize)

      return {
        edges: items.map((node) => ({ node })),
        pageInfo: {
          currentPage: page,
          totalPages,
          totalCount,
          hasNextPage: page < totalPages,
        },
      }
    },
  },

  // ──────────────────── Field Resolvers ────────────────────

  Coin: {
    networks: (coin: any) => {
      // coin.mappings is already included from the query
      return (coin.mappings ?? []).map((m: any) => ({
        network: m.network,
        contractAddress: m.contractAddress,
        decimals: m.decimals,
        depositEnabled: m.depositEnabled,
        withdrawEnabled: m.withdrawEnabled,
      }))
    },
  },

  ExchangeRequest: {
    depositAddress: (er: any) => er.depositAddress ?? null,
    transactions: (er: any) => er.transactions ?? [],
  },
}

// ──────────────────── Binance Rate Helper ────────────────────

async function getBinanceRate(fromCode: string, toCode: string): Promise<Decimal> {
  // Same pair
  if (fromCode === toCode) return new Prisma.Decimal(1)

  // Try direct pair
  const directRate = await fetchBinancePrice(`${fromCode}${toCode}`)
  if (directRate) return directRate

  // Try inverted pair
  const invertedRate = await fetchBinancePrice(`${toCode}${fromCode}`)
  if (invertedRate) return new Prisma.Decimal(1).div(invertedRate)

  // Fallback: route through USDT
  if (fromCode !== "USDT" && toCode !== "USDT") {
    const fromUsdt = await fetchBinancePrice(`${fromCode}USDT`)
    const toUsdt = await fetchBinancePrice(`${toCode}USDT`)
    if (fromUsdt && toUsdt) {
      return fromUsdt.div(toUsdt)
    }
  }

  throw new Error(`Unable to fetch exchange rate for ${fromCode} → ${toCode}`)
}

async function fetchBinancePrice(symbol: string): Promise<Decimal | null> {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`,
    )
    if (!res.ok) return null
    const data = (await res.json()) as { price: string }
    return new Prisma.Decimal(data.price)
  } catch {
    return null
  }
}
