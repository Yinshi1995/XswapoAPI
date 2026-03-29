import { Prisma } from "@prisma/client"
type Decimal = Prisma.Decimal
import type { GraphQLContext } from "../context"
import { resolveNetwork } from "../lib/resolveNetwork"

export const mutationResolvers = {
  Mutation: {
    /**
     * Create a new exchange request.
     * Mirrors Swapuz POST /api/home/v1/order
     *
     * Steps:
     *  1. Validate coins, networks, and mappings
     *  2. Validate amount against limits
     *  3. Calculate estimated rate and fee
     *  4. Find the active master wallet for fromCoin+fromNetwork
     *  5. Derive next deposit address (increment index)
     *  6. Create the ExchangeRequest + DepositAddress in a transaction
     *  7. Return the full exchange request
     *
     * NOTE: Tatum subscription creation (webhook setup) is handled by a
     * separate background service / the admin flow. This API only creates
     * the DB records. The admin app's createExchangeRequest mutation handles
     * the full Tatum orchestration — we keep the client API focused on
     * data persistence and let the webhook/subscription layer run separately.
     */
    createExchangeRequest: async (
      _parent: unknown,
      args: {
        input: {
          from: string
          fromNetwork: string
          to: string
          toNetwork: string
          amount: string
          address: string
        }
      },
      ctx: GraphQLContext,
    ) => {
      const { from, fromNetwork, to, toNetwork, amount, address } = args.input

      // ── 1. Validate coins ──
      const [fromCoin, toCoin] = await Promise.all([
        ctx.prisma.coin.findFirst({ where: { code: from, status: "ACTIVE" } }),
        ctx.prisma.coin.findFirst({ where: { code: to, status: "ACTIVE" } }),
      ])
      if (!fromCoin) throw new Error(`Coin ${from} not found or inactive`)
      if (!toCoin) throw new Error(`Coin ${to} not found or inactive`)

      // ── 2. Validate networks ──
      const [fromNet, toNet] = await Promise.all([
        resolveNetwork(ctx.prisma, fromNetwork),
        resolveNetwork(ctx.prisma, toNetwork),
      ])
      if (!fromNet) throw new Error(`Network ${fromNetwork} not found or inactive`)
      if (!toNet) throw new Error(`Network ${toNetwork} not found or inactive`)

      // ── 3. Validate coin-network mappings ──
      const [fromMapping, toMapping] = await Promise.all([
        ctx.prisma.coinNetworkMapping.findUnique({
          where: {
            coinId_networkId: { coinId: fromCoin.id, networkId: fromNet.id },
          },
        }),
        ctx.prisma.coinNetworkMapping.findUnique({
          where: {
            coinId_networkId: { coinId: toCoin.id, networkId: toNet.id },
          },
        }),
      ])
      if (!fromMapping?.isActive || !fromMapping.depositEnabled) {
        throw new Error(`Deposits for ${from} on ${fromNetwork} are not available`)
      }
      if (!toMapping?.isActive || !toMapping.withdrawEnabled) {
        throw new Error(`Withdrawals for ${to} on ${toNetwork} are not available`)
      }

      // ── 4. Validate amount ──
      const inputAmount = new Prisma.Decimal(amount)
      if (inputAmount.lte(0)) throw new Error("Amount must be positive")
      if (inputAmount.lt(fromCoin.minDepositAmount)) {
        throw new Error(
          `Amount ${inputAmount} is below the minimum of ${fromCoin.minDepositAmount} ${from}`,
        )
      }
      if (fromCoin.maxDepositAmount && inputAmount.gt(fromCoin.maxDepositAmount)) {
        throw new Error(
          `Amount ${inputAmount} is above the maximum of ${fromCoin.maxDepositAmount} ${from}`,
        )
      }

      // ── 5. Validate address (basic non-empty check) ──
      const trimmedAddress = address.trim()
      if (!trimmedAddress) throw new Error("Withdraw address is required")

      // ── 6. Calculate rate and fee ──
      const rate = await getBinanceRate(fromCoin.code, toCoin.code)
      const feePercent = fromCoin.floatFeePercent
      let feeAmount = inputAmount.mul(feePercent).div(100)
      if (feeAmount.lt(fromCoin.minimumFee)) {
        feeAmount = fromCoin.minimumFee
      }
      const effectiveAmount = inputAmount.minus(feeAmount)
      const toAmount = effectiveAmount.mul(rate)

      // ── 7. Find master wallet for the deposit side ──
      const masterWallet = await ctx.prisma.masterWallet.findFirst({
        where: {
          coinId: fromCoin.id,
          networkId: fromNet.id,
          status: "ACTIVE",
        },
      })
      if (!masterWallet) {
        throw new Error(
          `No active master wallet for ${from} on ${fromNetwork}. Please contact support.`,
        )
      }

      // ── 8. Create everything in a DB transaction ──
      const exchangeRequest = await ctx.prisma.$transaction(async (tx) => {
        // Increment master wallet index
        const updatedWallet = await tx.masterWallet.update({
          where: { xpub: masterWallet.xpub },
          data: {
            currentIndex: { increment: 1 },
            generatedAddresses: { increment: 1 },
          },
        })

        const depositIndex = updatedWallet.currentIndex

        // Generate deposit address via Tatum (placeholder — in production
        // this calls Tatum API). For now we create a DB record; the actual
        // blockchain address derivation happens via the admin service or a
        // shared Tatum integration.
        const depositAddress = await tx.depositAddress.create({
          data: {
            address: `pending-${fromCoin.code}-${fromNet.code}-${depositIndex}`,
            index: depositIndex,
            masterWalletxpub: masterWallet.xpub,
          },
        })

        // Create the exchange request
        const er = await tx.exchangeRequest.create({
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
          include: {
            fromCoin: {
              include: {
                mappings: { where: { isActive: true }, include: { network: true } },
              },
            },
            toCoin: {
              include: {
                mappings: { where: { isActive: true }, include: { network: true } },
              },
            },
            fromNetwork: true,
            toNetwork: true,
            depositAddress: true,
            transactions: true,
          },
        })

        return er
      })

      return exchangeRequest
    },
  },
}

// ──────────────────── Binance Rate Helper ────────────────────

async function getBinanceRate(fromCode: string, toCode: string): Promise<Decimal> {
  if (fromCode === toCode) return new Prisma.Decimal(1)

  const directRate = await fetchBinancePrice(`${fromCode}${toCode}`)
  if (directRate) return directRate

  const invertedRate = await fetchBinancePrice(`${toCode}${fromCode}`)
  if (invertedRate) return new Prisma.Decimal(1).div(invertedRate)

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
