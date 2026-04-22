import { initTRPC, TRPCError } from "@trpc/server"
import { z } from "zod"
import { Prisma, PrismaClient } from "@prisma/client"
import { resolveNetwork } from "../lib/resolveNetwork"
import { validateApiKey } from "../lib/auth"
import { getKmsRate } from "../lib/kms"
import { createExchangeOrder, exchangeRequestInclude } from "../lib/orders"

// ─── Context ────────────────────────────────────────────────

export interface TRPCContext {
  prisma: PrismaClient
  apiKey: string | null
}

const t = initTRPC.context<TRPCContext>().create()

const authMiddleware = t.middleware(async ({ ctx, next }) => {
  if (!(await validateApiKey(ctx.prisma, ctx.apiKey))) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or missing API key" })
  }
  return next({ ctx })
})

const protectedProcedure = t.procedure.use(authMiddleware)

// ─── Shared helpers ─────────────────────────────────────────

function serializeCoin(coin: any) {
  return {
    code: coin.code,
    name: coin.name,
    minDepositAmount: coin.minDepositAmount?.toString(),
    maxDepositAmount: coin.maxDepositAmount?.toString() ?? null,
    networks: (coin.mappings ?? []).map((m: any) => ({
      code: m.network.code,
      name: m.network.name,
      depositEnabled: m.depositEnabled,
      withdrawEnabled: m.withdrawEnabled,
    })),
  }
}

function serializeExchangeRequest(er: any) {
  return {
    id: er.orderId ?? er.id,
    status: er.status,
    createdAt: er.createdAt,
    from: {
      coin: er.fromCoin?.code,
      network: er.fromNetwork?.code,
      amount: er.fromAmount?.toString(),
    },
    to: {
      coin: er.toCoin?.code,
      network: er.toNetwork?.code,
      amount: er.toAmount?.toString(),
    },
    rate: er.estimatedRate?.toString() ?? null,
    fee: er.feeAmount?.toString(),
    depositAddress: er.depositAddress?.address ?? null,
    withdrawAddress: er.clientWithdrawAddress,
    transactions: (er.transactions ?? []).map((tx: any) => ({
      type: tx.type,
      status: tx.status,
      amount: tx.amount?.toString(),
      txHash: tx.txHash ?? null,
    })),
  }
}

// ─── Prisma include preset ──────────────────────────────────

const coinInclude = {
  mappings: { where: { isActive: true }, include: { network: true } },
}

// ─── Router ─────────────────────────────────────────────────

export const appRouter = t.router({
  // ── coins.list ────────────────────────────────────────
  "coins.list": protectedProcedure.query(async ({ ctx }) => {
    const coins = await ctx.prisma.coin.findMany({
      where: { status: "ACTIVE" },
      include: coinInclude,
      orderBy: { name: "asc" },
    })
    return coins.map(serializeCoin)
  }),

  // ── coins.byCode ─────────────────────────────────────
  "coins.byCode": protectedProcedure
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
  "coins.limits": protectedProcedure
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
  "exchange.rate": protectedProcedure
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

      const rate = await getKmsRate(fromCoin.code, toCoin.code)
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
  // Delegates full exchange-creation flow (wallets, addresses, rate, notifications)
  // to KMS `exchange.createRequest`. See src/lib/orders.ts.
  "order.create": protectedProcedure
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
      const exchangeRequest = await createExchangeOrder(ctx.prisma, input)
      return serializeExchangeRequest(exchangeRequest)
    }),

  // ── order.byId ────────────────────────────────────────
  "order.byId": protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const er = await ctx.prisma.exchangeRequest.findFirst({
        where: { OR: [{ orderId: input.id }, { id: input.id }] },
        include: exchangeRequestInclude,
      })
      if (!er) throw new Error("Exchange request not found")
      return serializeExchangeRequest(er)
    }),

  // ── order.list ────────────────────────────────────────
  "order.list": protectedProcedure
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
