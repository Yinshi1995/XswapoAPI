import type { GraphQLContext } from "../context"
import { validateApiKey } from "../lib/auth"
import { createExchangeOrder } from "../lib/orders"

export const mutationResolvers = {
  Mutation: {
    /**
     * Create a new exchange request by delegating the entire flow to KMS
     * (`exchange.createRequest`). KMS is responsible for coin-network mapping
     * validation, MasterWallet/GasWallet provisioning, deposit address
     * derivation, server-side rate/fee calculation, order ID generation,
     * and operator notifications (Telegram, Redis).
     *
     * This resolver only authenticates the caller, translates public codes
     * into DB IDs, and returns the resulting ExchangeRequest for GraphQL
     * field resolution.
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
      if (!(await validateApiKey(ctx.prisma, ctx.apiKey))) {
        throw new Error("Invalid or missing API key")
      }
      return createExchangeOrder(ctx.prisma, args.input)
    },
  },
}
