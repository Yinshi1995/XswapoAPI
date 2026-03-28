import type { PrismaClient } from "@prisma/client"

export interface GraphQLContext {
  prisma: PrismaClient
  /** API key from request header (null if not provided) */
  apiKey: string | null
}
