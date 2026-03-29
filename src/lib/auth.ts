import { createHmac } from "crypto"
import type { PrismaClient } from "@prisma/client"

function hashApiKey(rawKey: string, salt: string): string {
  return createHmac("sha256", salt).update(rawKey).digest("hex")
}

/**
 * Validate a raw API key against the database.
 * Finds candidates by prefix, then verifies via HMAC-SHA256.
 */
export async function validateApiKey(
  prisma: PrismaClient,
  apiKey: string | null,
): Promise<boolean> {
  if (!apiKey) return false

  const prefix = apiKey.slice(0, 12)
  const candidates = await prisma.apiKey.findMany({
    where: { prefix, isActive: true },
  })

  for (const candidate of candidates) {
    if (hashApiKey(apiKey, candidate.salt) === candidate.hashedKey) {
      prisma.apiKey.update({
        where: { id: candidate.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => {})
      return true
    }
  }

  return false
}