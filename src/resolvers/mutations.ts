import { Prisma } from "@prisma/client"
import type { GraphQLContext } from "../context"
import { resolveNetwork } from "../lib/resolveNetwork"
import { validateApiKey } from "../lib/auth"
import { generateOrderId } from "../lib/generateOrderId"
import { getKmsRate, deriveDepositAddress } from "../lib/kms"

export const mutationResolvers = {
  Mutation: {
    /**
     * Create a new exchange request.
     * Mirrors Swapuz POST /api/home/v1/order
     *
     * Steps:
     *  1. Validate coins, networks, and mappings
     *  2. Validate amount against limits
     *  3. Calculate estimated rate and fee via KMS
     *  4. Find the active master wallet for fromCoin+fromNetwork
     *  5. Derive next deposit address via KMS (increment index)
     *  6. Create the ExchangeRequest + DepositAddress in a transaction
     *  7. Return the full exchange request
     *
     * All blockchain-side operations (rate lookup, address derivation)
     * are delegated to the XSwapo KMS microservice. See src/lib/kms.ts.
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
      if (!(await validateApiKey(ctx.prisma, ctx.apiKey))) throw new Error("Invalid or missing API key")

      const { from, fromNetwork, to, toNetwork, amount, address } = args.input

      const [fromCoin, toCoin] = await Promise.all([
        ctx.prisma.coin.findFirst({ where: { code: from, status: "ACTIVE" } }),
        ctx.prisma.coin.findFirst({ where: { code: to, status: "ACTIVE" } }),
      ])
      if (!fromCoin) throw new Error(`Coin ${from} not found or inactive`)
      if (!toCoin) throw new Error(`Coin ${to} not found or inactive`)

      const [fromNet, toNet] = await Promise.all([
        resolveNetwork(ctx.prisma, fromNetwork),
        resolveNetwork(ctx.prisma, toNetwork),
      ])
      if (!fromNet) throw new Error(`Network ${fromNetwork} not found or inactive`)
      if (!toNet) throw new Error(`Network ${toNetwork} not found or inactive`)

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

      const trimmedAddress = address.trim()
      if (!trimmedAddress) throw new Error("Withdraw address is required")

      const rate = await getKmsRate(fromCoin.code, toCoin.code)
      const feePercent = fromCoin.floatFeePercent
      let feeAmount = inputAmount.mul(feePercent).div(100)
      if (feeAmount.lt(fromCoin.minimumFee)) {
        feeAmount = fromCoin.minimumFee
      }
      const effectiveAmount = inputAmount.minus(feeAmount)
      const toAmount = effectiveAmount.mul(rate)

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

      const exchangeRequest = await ctx.prisma.$transaction(
        async (tx) => {
          const updatedWallet = await tx.masterWallet.update({
            where: { xpub: masterWallet.xpub },
            data: {
              currentIndex: { increment: 1 },
              generatedAddresses: { increment: 1 },
            },
          })

          const depositIndex = updatedWallet.currentIndex

          // Delegate address derivation to KMS. For secp256k1 chains the
          // stored `xpub` is an extended public key; for Ed25519 chains
          // it is a mnemonic — KMS dispatches by `chain`.
          const derivedAddress = await deriveDepositAddress({
            xpub: masterWallet.xpub,
            index: depositIndex,
            chain: fromNet.chain,
          })

          const depositAddress = await tx.depositAddress.create({
            data: {
              address: derivedAddress,
              index: depositIndex,
              masterWalletxpub: masterWallet.xpub,
            },
          })

          return tx.exchangeRequest.create({
            data: {
              orderId: generateOrderId(),
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
        },
        { timeout: 20_000, maxWait: 5_000 },
      )

      return exchangeRequest
    },
  },
}
