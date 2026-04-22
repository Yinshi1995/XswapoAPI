import type { PrismaClient } from "@prisma/client"
import { resolveNetwork } from "./resolveNetwork"
import { kms } from "./kms"

/**
 * Shared Prisma include preset for ExchangeRequest reads across GraphQL,
 * REST, and tRPC layers. Keeps the shape consistent for serialization.
 */
export const exchangeRequestInclude = {
  fromCoin: { include: { mappings: { where: { isActive: true }, include: { network: true } } } },
  toCoin: { include: { mappings: { where: { isActive: true }, include: { network: true } } } },
  fromNetwork: true,
  toNetwork: true,
  depositAddress: true,
  transactions: { orderBy: { createdAt: "desc" as const } },
} as const

export interface CreateOrderInput {
  from: string
  fromNetwork: string
  to: string
  toNetwork: string
  amount: string
  address: string
}

/**
 * Create an exchange request by delegating the full flow to KMS.
 *
 * KMS handles coin-network mapping validation, MasterWallet / GasWallet
 * provisioning, deposit address derivation, server-side rate and fee
 * calculation, order ID generation, and operator notifications.
 *
 * This api only translates public coin/network codes into DB IDs and
 * re-fetches the created record with relations for serialization.
 *
 * NOTE: KMS and api share the same PostgreSQL database, so the record
 * is available for lookup by id immediately after the KMS call returns.
 */
export async function createExchangeOrder(prisma: PrismaClient, input: CreateOrderInput) {
  const fromUpper = input.from.toUpperCase()
  const toUpper = input.to.toUpperCase()
  const trimmedAddress = input.address.trim()
  if (!trimmedAddress) throw new Error("Withdraw address is required")

  const fromAmount = Number(input.amount)
  if (!Number.isFinite(fromAmount) || fromAmount <= 0) {
    throw new Error("Amount must be a positive number")
  }

  const [fromCoin, toCoin, fromNet, toNet] = await Promise.all([
    prisma.coin.findFirst({ where: { code: fromUpper, status: "ACTIVE" } }),
    prisma.coin.findFirst({ where: { code: toUpper, status: "ACTIVE" } }),
    resolveNetwork(prisma, input.fromNetwork.toUpperCase()),
    resolveNetwork(prisma, input.toNetwork.toUpperCase()),
  ])
  if (!fromCoin) throw new Error(`Coin ${fromUpper} not found or inactive`)
  if (!toCoin) throw new Error(`Coin ${toUpper} not found or inactive`)
  if (!fromNet) throw new Error(`Network ${input.fromNetwork} not found or inactive`)
  if (!toNet) throw new Error(`Network ${input.toNetwork} not found or inactive`)

  // KMS requires `toAmount` to satisfy its zod schema but recalculates
  // the actual payout server-side from its own spot rate and toCoin fees.
  // We pass `fromAmount` as a positive placeholder.
  const kmsResult = await kms.exchange.createRequest({
    fromCoinId: fromCoin.id,
    fromNetworkId: fromNet.id,
    toCoinId: toCoin.id,
    toNetworkId: toNet.id,
    fromAmount,
    toAmount: fromAmount,
    clientWithdrawAddress: trimmedAddress,
  })

  const exchangeRequest = await prisma.exchangeRequest.findUnique({
    where: { id: kmsResult.id },
    include: exchangeRequestInclude,
  })
  if (!exchangeRequest) {
    throw new Error(
      `Exchange request ${kmsResult.id} was created in KMS but is not visible in the database`,
    )
  }

  return exchangeRequest
}

export type ExchangeRequestWithRelations = NonNullable<
  Awaited<ReturnType<typeof createExchangeOrder>>
>
