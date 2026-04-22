import { Prisma } from "@prisma/client"

type Decimal = Prisma.Decimal

const KMS_URL = (process.env.KMS_URL ?? "http://localhost:3001").replace(/\/$/, "")
const KMS_TIMEOUT_MS = Number(process.env.KMS_TIMEOUT_MS) || 15_000

interface TRPCResponse<T> {
  result?: { data?: T }
  error?: { message?: string; code?: number; data?: unknown }
}

async function kmsFetch<T>(path: string, init: RequestInit, label: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), KMS_TIMEOUT_MS)
  const fullUrl = `${KMS_URL}/trpc/${path}`
  let res: Response
  try {
    res = await fetch(fullUrl, { ...init, signal: controller.signal })
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(`KMS ${label} timed out after ${KMS_TIMEOUT_MS}ms (url=${KMS_URL})`)
    }
    // Network-level failure (DNS / connection refused / TLS / …).
    throw new Error(
      `KMS ${label} unreachable at ${KMS_URL}: ${e?.message ?? e}. ` +
        `Check the KMS_URL env variable and that the KMS service is running.`,
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let body: TRPCResponse<T>
  try {
    body = JSON.parse(text) as TRPCResponse<T>
  } catch {
    throw new Error(
      `KMS ${label} returned non-JSON response (${res.status}) from ${KMS_URL}: ${text.slice(0, 200)}`,
    )
  }
  if (!res.ok || body.error) {
    const msg = body.error?.message ?? `HTTP ${res.status}`
    throw new Error(`KMS ${label} failed: ${msg}`)
  }
  if (body.result === undefined || body.result.data === undefined) {
    throw new Error(`KMS ${label}: empty result`)
  }
  return body.result.data
}

async function kmsGet<T>(path: string, input: unknown): Promise<T> {
  const url = `${path}?input=${encodeURIComponent(JSON.stringify(input))}`
  return kmsFetch<T>(url, { method: "GET" }, path)
}

async function kmsPost<T>(path: string, input: unknown): Promise<T> {
  return kmsFetch<T>(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    path,
  )
}

export interface KmsWallet {
  mnemonic: string
  xpub: string
}

export interface KmsAddress {
  address: string
}

export interface KmsPrivateKey {
  key: string
}

export interface KmsBalance {
  balance: string
  raw: string
}

export interface KmsFee {
  fee: string
  raw?: string
  gasLimit?: string
  gasPrice?: string
}

export interface KmsTxId {
  txId: string
}

export interface KmsTxStatus {
  status: string
  confirmations?: number
  blockNumber?: number
  [key: string]: unknown
}

export interface KmsCryptoRate {
  symbol: string
  basePair: string
  value: number
  source: string
  timestamp: string
}

export interface KmsCryptoRatio {
  from: string
  to: string
  ratio: number
  fromPriceUsd: number
  toPriceUsd: number
  amount?: number
  estimatedReceive?: number
  timestamp: string
}

export interface KmsExchangeRequest {
  id: string
  orderId: string
  depositAddress: { address: string }
  fromAmount: number
  toAmount: number
  estimatedRate: number
  feeAmount: number
  status: string
}

export interface KmsCreateExchangeInput {
  fromCoinId: string
  fromNetworkId: string
  toCoinId: string
  toNetworkId: string
  fromAmount: number | string
  toAmount: number | string
  clientWithdrawAddress: string
  feeAmount?: number | string
}

/**
 * Thin tRPC-over-HTTP client for the XSwapo KMS microservice.
 * All blockchain-side operations (address derivation, balance checks,
 * fee estimation, broadcasting, rates) are delegated to KMS instead of
 * being implemented locally here.
 */
export const kms = {
  wallet: {
    generate: (chain: string) => kmsPost<KmsWallet>("wallet.generate", { chain }),
    deriveAddress: (params: { xpub: string; index: number; chain: string }) =>
      kmsGet<KmsAddress>("wallet.deriveAddress", params),
    derivePrivateKey: (params: { mnemonic: string; index: number; chain: string }) =>
      kmsGet<KmsPrivateKey>("wallet.derivePrivateKey", params),
  },
  balance: {
    native: (params: { address: string; chain: string }) =>
      kmsGet<KmsBalance>("balance.native", params),
    token: (params: { address: string; chain: string; contract: string }) =>
      kmsGet<KmsBalance>("balance.token", params),
  },
  fee: {
    estimate: (params: { chain: string; from?: string; to?: string; amount?: string }) =>
      kmsGet<KmsFee>("fee.estimate", params),
  },
  send: {
    native: (params: { chain: string; privateKey: string; to: string; amount: string }) =>
      kmsPost<KmsTxId>("send.native", params),
    token: (params: {
      chain: string
      privateKey: string
      to: string
      amount: string
      contract: string
    }) => kmsPost<KmsTxId>("send.token", params),
  },
  tx: {
    status: (params: { chain: string; txId: string }) =>
      kmsGet<KmsTxStatus>("tx.status", params),
  },
  rate: {
    getCryptoRate: (params: { symbol: string; basePair?: string }) =>
      kmsGet<KmsCryptoRate>("rate.getCryptoRate", params),
    getCryptoRatio: (params: { from: string; to: string; amount?: number }) =>
      kmsGet<KmsCryptoRatio>("rate.getCryptoRatio", params),
  },
  exchange: {
    /**
     * Full exchange-request creation pipeline, delegated to KMS.
     * KMS handles: mapping validation, MasterWallet + GasWallet provisioning,
     * deposit address derivation, server-side rate calculation, order ID
     * allocation, and operator notifications (Telegram, Redis).
     */
    createRequest: (params: KmsCreateExchangeInput) =>
      kmsPost<KmsExchangeRequest>("exchange.createRequest", params),
  },
}

/**
 * Get an exchange ratio between two coins via KMS.
 * Replaces the previous direct Binance lookup — KMS aggregates from
 * 10+ CEX and 100+ DEX and is the single source of truth for rates.
 */
export async function getKmsRate(fromCode: string, toCode: string): Promise<Decimal> {
  if (fromCode === toCode) return new Prisma.Decimal(1)
  const { ratio } = await kms.rate.getCryptoRatio({ from: fromCode, to: toCode })
  // Use string conversion to preserve precision through Decimal
  return new Prisma.Decimal(ratio.toString())
}

/**
 * Derive the next deposit address for a master wallet through KMS.
 * `xpub` field stores the extended public key for secp256k1 chains
 * and the mnemonic for Ed25519 chains — KMS picks the right derivation
 * mode based on `chain`.
 */
export async function deriveDepositAddress(params: {
  xpub: string
  index: number
  chain: string
}): Promise<string> {
  const { address } = await kms.wallet.deriveAddress(params)
  return address
}
