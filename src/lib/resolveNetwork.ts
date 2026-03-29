import { PrismaClient } from "@prisma/client"

/**
 * Resolve a network by code, with fallback to CODE_MAINNET.
 * Allows users to pass short codes like "BTC" which resolve to "BTC_MAINNET".
 */
export async function resolveNetwork(prisma: PrismaClient, code: string) {
  const net = await prisma.network.findFirst({ where: { code, status: "ACTIVE" } })
  if (net) return net
  return prisma.network.findFirst({ where: { code: `${code}_MAINNET`, status: "ACTIVE" } })
}
