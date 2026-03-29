import { initTRPC } from "@trpc/server"
import { z } from "zod"
import { Prisma, PrismaClient } from "@prisma/client"
import { resolveNetwork } from "../lib/resolveNetwork"

type Decimal = Prisma.Decimal

// ─── Context ────────────────────────────────────────────────

export interface TRPCContext {
  prisma: PrismaClient
  apiKey: string | null
}

const t = initTRPC.context<TRPCContext>().create()

// ─── Shared helpers ─────────────────────────────────────────

function serializeCoin(coin: any) {
  return {
    id: coin.id,
    code: coin.code,
    name: coin.name,
    imageUrl: coin.imageUrl,
    minDepositAmount: coin.minDepositAmount?.toString(),
    maxDepositAmount: coin.maxDepositAmount?.toString() ?? null,
    networks: (coin.mappings ?? []).map((m: any) => ({
      network: {
        id: m.network.id,
        code: m.network.code,
        name: m.network.name,
        chain: m.network.chain,
        isDepositEnabled: m.network.isDepositEnabled,
        isWithdrawEnabled: m.network.isWithdrawEnabled,
        explorerUrl: m.network.explorerUrl,
        imageUrl: m.network.imageUrl,
      },
      contractAddress: m.contractAddress,
      decimals: m.decimals,
      depositEnabled: m.depositEnabled,
      withdrawEnabled: m.withdrawEnabled,
    })),
  }
}

function serializeExchangeRequest(er: any) {
  return {
    id: er.id,
    createdAt: er.createdAt,
    updatedAt: er.updatedAt,
    status: er.status,
    fromCoin: er.fromCoin ? serializeCoin(er.fromCoin) : undefined,
    fromNetwork: er.fromNetwork
      ? { id: er.fromNetwork.id, code: er.fromNetwork.code, name: er.fromNetwork.name, chain: er.fromNetwork.chain }
      : undefined,
    toCoin: er.toCoin ? serializeCoin(er.toCoin) : undefined,
    toNetwork: er.toNetwork
      ? { id: er.toNetwork.id, code: er.toNetwork.code, name: er.toNetwork.name, chain: er.toNetwork.chain }
      : undefined,
    fromAmount: er.fromAmount?.toString(),
    toAmount: er.toAmount?.toString(),
    receivedAmount: er.receivedAmount?.toString() ?? null,
    acceptedAmount: er.acceptedAmount?.toString() ?? null,
    estimatedRate: er.estimatedRate?.toString() ?? null,
    feeAmount: er.feeAmount?.toString(),
    clientWithdrawAddress: er.clientWithdrawAddress,
    depositAddress: er.depositAddress ? { address: er.depositAddress.address } : null,
    completedAt: er.completedAt,
    failedReason: er.failedReason,
    transactions: (er.transactions ?? []).map((tx: any) => ({
      id: tx.id,
      type: tx.type,
      status: tx.status,
      amount: tx.amount?.toString(),
      confirmedAmount: tx.confirmedAmount?.toString() ?? null,
      txHash: tx.txHash,
      createdAt: tx.createdAt,
      detectedAt: tx.detectedAt,
      confirmedAt: tx.confirmedAt,
    })),
  }
}

// ─── Binance rate ───────────────────────────────────────────

async function getBinanceRate(fromCode: string, toCode: string): Promise<Decimal> {
  if (fromCode === toCode) return new Prisma.Decimal(1)

  const direct = await fetchBinancePrice(`${fromCode}${toCode}`)
  if (direct) return direct

  const inverted = await fetchBinancePrice(`${toCode}${fromCode}`)
  if (inverted) return new Prisma.Decimal(1).div(inverted)

  if (fromCode !== "USDT" && toCode !== "USDT") {
    const fromUsdt = await fetchBinancePrice(`${fromCode}USDT`)
    const toUsdt = await fetchBinancePrice(`${toCode}USDT`)
    if (fromUsdt && toUsdt) return fromUsdt.div(toUsdt)
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

// ─── Prisma include preset ──────────────────────────────────

const coinInclude = {
  mappings: { where: { isActive: true }, include: { network: true } },
}

const exchangeRequestInclude = {
  fromCoin: { include: coinInclude },
  toCoin: { include: coinInclude },
  fromNetwork: true,
  toNetwork: true,
  depositAddress: true,
  transactions: { orderBy: { createdAt: "desc" as const } },
}

// ─── Router ─────────────────────────────────────────────────

export const appRouter = t.router({
  // ── coins.list ────────────────────────────────────────
  "coins.list": t.procedure.query(async ({ ctx }) => {
    const coins = await ctx.prisma.coin.findMany({
      where: { status: "ACTIVE" },
      include: coinInclude,
      orderBy: { name: "asc" },
    })
    return coins.map(serializeCoin)
  }),

  // ── coins.byCode ─────────────────────────────────────
  "coins.byCode": t.procedure
    .input(z.object({ code: z.string() }))
    .query(async ({ ctx, input }) => {
      const coin = await ctx.prisma.coin.findFirst({
        where: { code: input.code.toUpperCase(), status: "ACTIVE" },
        include: coinInclude,
      })
      if (!coin) throw new Error("Coin not found")
      return serializeCoin(coin)
    }),

  // ── limits ────────────────────────────────────────────
  "coins.limits": t.procedure
    .input(z.object({ coin: z.string() }))
    .query(async ({ ctx, input }) => {
      const coin = await ctx.prisma.coin.findUnique({
        where: { code: input.coin.toUpperCase() },
      })
      if (!coin) throw new Error("Coin not found")
      return {
        coin: coin.code,
        minAmount: coin.minDepositAmount.toString(),
        maxAmount: coin.maxDepositAmount?.toString() ?? null,
      }
    }),

  // ── rate ──────────────────────────────────────────────
  "exchange.rate": t.procedure
    .input(
      z.object({
        from: z.string(),
        to: z.string(),
        amount: z.string(),
        fromNetwork: z.string(),
        toNetwork: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const from = input.from.toUpperCase()
      const to = input.to.toUpperCase()
      const fromNetCode = input.fromNetwork.toUpperCase()
      const toNetCode = input.toNetwork.toUpperCase()

      const [fromCoin, toCoin] = await Promise.all([
        ctx.prisma.coin.findFirst({ where: { code: from, status: "ACTIVE" } }),
        ctx.prisma.coin.findFirst({ where: { code: to, status: "ACTIVE" } }),
      ])
      if (!fromCoin) throw new Error(`Coin ${from} not found or inactive`)
      if (!toCoin) throw new Error(`Coin ${to} not found or inactive`)

      const [fromNet, toNet] = await Promise.all([
        resolveNetwork(ctx.prisma, fromNetCode),
        resolveNetwork(ctx.prisma, toNetCode),
      ])
      if (!fromNet) throw new Error(`Network ${fromNetCode} not found or inactive`)
      if (!toNet) throw new Error(`Network ${toNetCode} not found or inactive`)

      const [fromMapping, toMapping] = await Promise.all([
        ctx.prisma.coinNetworkMapping.findUnique({
          where: { coinId_networkId: { coinId: fromCoin.id, networkId: fromNet.id } },
        }),
        ctx.prisma.coinNetworkMapping.findUnique({
          where: { coinId_networkId: { coinId: toCoin.id, networkId: toNet.id } },
        }),
      ])
      if (!fromMapping?.isActive) throw new Error(`${from} is not available on ${fromNetCode}`)
      if (!toMapping?.isActive) throw new Error(`${to} is not available on ${toNetCode}`)

      const rate = await getBinanceRate(fromCoin.code, toCoin.code)
      const inputAmount = new Prisma.Decimal(input.amount)

      if (inputAmount.lt(fromCoin.minDepositAmount)) {
        throw new Error(`Amount below minimum of ${fromCoin.minDepositAmount} ${from}`)
      }
      if (fromCoin.maxDepositAmount && inputAmount.gt(fromCoin.maxDepositAmount)) {
        throw new Error(`Amount above maximum of ${fromCoin.maxDepositAmount} ${from}`)
      }

      let feeAmount = inputAmount.mul(fromCoin.floatFeePercent).div(100)
      if (feeAmount.lt(fromCoin.minimumFee)) feeAmount = fromCoin.minimumFee
      const result = inputAmount.minus(feeAmount).mul(rate)

      return {
        result: result.toString(),
        amount: inputAmount.toString(),
        rate: rate.toString(),
        feeAmount: feeAmount.toString(),
        minAmount: fromCoin.minDepositAmount.toString(),
        maxAmount: fromCoin.maxDepositAmount?.toString() ?? null,
      }
    }),

  // ── order.create ──────────────────────────────────────
  "order.create": t.procedure
    .input(
      z.object({
        from: z.string(),
        fromNetwork: z.string(),
        to: z.string(),
        toNetwork: z.string(),
        amount: z.string(),
        address: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const fromUpper = input.from.toUpperCase()
      const toUpper = input.to.toUpperCase()
      const fromNetUpper = input.fromNetwork.toUpperCase()
      const toNetUpper = input.toNetwork.toUpperCase()
      const trimmedAddress = input.address.trim()
      if (!trimmedAddress) throw new Error("Withdraw address is required")

      const [fromCoin, toCoin] = await Promise.all([
        ctx.prisma.coin.findFirst({ where: { code: fromUpper, status: "ACTIVE" } }),
        ctx.prisma.coin.findFirst({ where: { code: toUpper, status: "ACTIVE" } }),
      ])
      if (!fromCoin) throw new Error(`Coin ${fromUpper} not found or inactive`)
      if (!toCoin) throw new Error(`Coin ${toUpper} not found or inactive`)

      const [fromNet, toNet] = await Promise.all([
        resolveNetwork(ctx.prisma, fromNetUpper),
        resolveNetwork(ctx.prisma, toNetUpper),
      ])
      if (!fromNet) throw new Error(`Network ${fromNetUpper} not found or inactive`)
      if (!toNet) throw new Error(`Network ${toNetUpper} not found or inactive`)

      const [fromMapping, toMapping] = await Promise.all([
        ctx.prisma.coinNetworkMapping.findUnique({
          where: { coinId_networkId: { coinId: fromCoin.id, networkId: fromNet.id } },
        }),
        ctx.prisma.coinNetworkMapping.findUnique({
          where: { coinId_networkId: { coinId: toCoin.id, networkId: toNet.id } },
        }),
      ])
      if (!fromMapping?.isActive || !fromMapping.depositEnabled) {
        throw new Error(`Deposits for ${fromUpper} on ${fromNetUpper} are not available`)
      }
      if (!toMapping?.isActive || !toMapping.withdrawEnabled) {
        throw new Error(`Withdrawals for ${toUpper} on ${toNetUpper} are not available`)
      }

      const inputAmount = new Prisma.Decimal(input.amount)
      if (inputAmount.lte(0)) throw new Error("Amount must be positive")
      if (inputAmount.lt(fromCoin.minDepositAmount)) {
        throw new Error(`Amount below minimum of ${fromCoin.minDepositAmount} ${fromUpper}`)
      }
      if (fromCoin.maxDepositAmount && inputAmount.gt(fromCoin.maxDepositAmount)) {
        throw new Error(`Amount above maximum of ${fromCoin.maxDepositAmount} ${fromUpper}`)
      }

      const rate = await getBinanceRate(fromCoin.code, toCoin.code)
      let feeAmount = inputAmount.mul(fromCoin.floatFeePercent).div(100)
      if (feeAmount.lt(fromCoin.minimumFee)) feeAmount = fromCoin.minimumFee
      const toAmount = inputAmount.minus(feeAmount).mul(rate)

      const masterWallet = await ctx.prisma.masterWallet.findFirst({
        where: { coinId: fromCoin.id, networkId: fromNet.id, status: "ACTIVE" },
      })
      if (!masterWallet) {
        throw new Error(`No active master wallet for ${fromUpper} on ${fromNetUpper}. Contact support.`)
      }

      const exchangeRequest = await ctx.prisma.$transaction(async (tx) => {
        const updatedWallet = await tx.masterWallet.update({
          where: { xpub: masterWallet.xpub },
          data: { currentIndex: { increment: 1 }, generatedAddresses: { increment: 1 } },
        })
        const depositAddress = await tx.depositAddress.create({
          data: {
            address: `pending-${fromCoin.code}-${fromNet.code}-${updatedWallet.currentIndex}`,
            index: updatedWallet.currentIndex,
            masterWalletxpub: masterWallet.xpub,
          },
        })
        return tx.exchangeRequest.create({
          data: {
            fromCoinId: fromCoin.id,
            fromNetworkId: fromNet.id,
            toCoinId: toCoin.id,
            toNetworkId: toNet.id,
            fromAmount: inputAmount,
            toAmount,
            clientWithdrawAddress: trimmedAddress,
            depositAddressId: depositAddress.id,
            status: "CREATED",
            estimatedRate: rate,
            feeAmount,
          },
          include: exchangeRequestInclude,
        })
      })

      return serializeExchangeRequest(exchangeRequest)
    }),

  // ── order.byId ────────────────────────────────────────
  "order.byId": t.procedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const er = await ctx.prisma.exchangeRequest.findUnique({
        where: { id: input.id },
        include: exchangeRequestInclude,
      })
      if (!er) throw new Error("Exchange request not found")
      return serializeExchangeRequest(er)
    }),

  // ── order.list ────────────────────────────────────────
  "order.list": t.procedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
        status: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where = input.status ? { status: input.status.toUpperCase() as any } : {}
      const skip = (input.page - 1) * input.pageSize

      const [items, totalCount] = await Promise.all([
        ctx.prisma.exchangeRequest.findMany({
          where,
          skip,
          take: input.pageSize,
          orderBy: { createdAt: "desc" },
          include: exchangeRequestInclude,
        }),
        ctx.prisma.exchangeRequest.count({ where }),
      ])

      const totalPages = Math.ceil(totalCount / input.pageSize)
      return {
        result: items.map(serializeExchangeRequest),
        pagination: {
          currentPage: input.page,
          totalPages,
          totalCount,
          hasNextPage: input.page < totalPages,
        },
      }
    }),
})

export type AppRouter = typeof appRouter
