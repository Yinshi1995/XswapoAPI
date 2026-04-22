import { Prisma, PrismaClient } from "@prisma/client"
import { resolveNetwork } from "../lib/resolveNetwork"
import { validateApiKey } from "../lib/auth"
import { generateOrderId } from "../lib/generateOrderId"
import { getKmsRate, deriveDepositAddress } from "../lib/kms"

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

// ─── JSON response helpers ──────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  })
}

function error(message: string, status = 400) {
  return json({ error: message, status }, status)
}

// ─── Exchange request include preset ────────────────────────

const exchangeRequestInclude = {
  fromCoin: { include: { mappings: { where: { isActive: true }, include: { network: true } } } },
  toCoin: { include: { mappings: { where: { isActive: true }, include: { network: true } } } },
  fromNetwork: true,
  toNetwork: true,
  depositAddress: true,
  transactions: { orderBy: { createdAt: "desc" as const } },
}

// ─── Route handler ──────────────────────────────────────────

export async function handleRestRequest(
  req: Request,
  url: URL,
  prisma: PrismaClient,
): Promise<Response | null> {
  const path = url.pathname
  const method = req.method

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-api-key, api-key",
      },
    })
  }

  // ── API Key authentication ──
  const apiKey = req.headers.get("x-api-key") ?? req.headers.get("api-key")
  if (!(await validateApiKey(prisma, apiKey))) {
    return error("Invalid or missing API key", 401)
  }

  // ─── GET /api/v1/coins ─────────────────────────────────
  if (method === "GET" && path === "/api/v1/coins") {
    const coins = await prisma.coin.findMany({
      where: { status: "ACTIVE" },
      include: { mappings: { where: { isActive: true }, include: { network: true } } },
      orderBy: { name: "asc" },
    })
    return json({ result: coins.map(serializeCoin), status: 200 })
  }

  // ─── GET /api/v1/coin/:code ────────────────────────────
  const coinMatch = path.match(/^\/api\/v1\/coin\/([A-Za-z0-9]+)$/)
  if (method === "GET" && coinMatch) {
    const code = coinMatch[1]!.toUpperCase()
    const coin = await prisma.coin.findFirst({
      where: { code, status: "ACTIVE" },
      include: { mappings: { where: { isActive: true }, include: { network: true } } },
    })
    if (!coin) return error("Coin not found", 404)
    return json({ result: serializeCoin(coin), status: 200 })
  }

  // ─── GET /api/v1/limits?coin=BTC ──────────────────────
  if (method === "GET" && path === "/api/v1/limits") {
    const coinCode = url.searchParams.get("coin")?.toUpperCase()
    if (!coinCode) return error("Query parameter 'coin' is required")
    const coin = await prisma.coin.findUnique({ where: { code: coinCode } })
    if (!coin) return error("Coin not found", 404)
    return json({
      result: {
        coin: coin.code,
        minAmount: coin.minDepositAmount.toString(),
        maxAmount: coin.maxDepositAmount?.toString() ?? null,
      },
      status: 200,
    })
  }

  // ─── GET /api/v1/rate ─────────────────────────────────
  if (method === "GET" && path === "/api/v1/rate") {
    const from = url.searchParams.get("from")?.toUpperCase()
    const to = url.searchParams.get("to")?.toUpperCase()
    const amount = url.searchParams.get("amount")
    const fromNetwork = url.searchParams.get("fromNetwork")?.toUpperCase()
    const toNetwork = url.searchParams.get("toNetwork")?.toUpperCase()

    if (!from || !to || !amount || !fromNetwork || !toNetwork) {
      return error("Required query parameters: from, to, amount, fromNetwork, toNetwork")
    }

    try {
      const [fromCoin, toCoin] = await Promise.all([
        prisma.coin.findFirst({ where: { code: from, status: "ACTIVE" } }),
        prisma.coin.findFirst({ where: { code: to, status: "ACTIVE" } }),
      ])
      if (!fromCoin) return error(`Coin ${from} not found or inactive`, 404)
      if (!toCoin) return error(`Coin ${to} not found or inactive`, 404)

      const [fromNet, toNet] = await Promise.all([
        resolveNetwork(prisma, fromNetwork),
        resolveNetwork(prisma, toNetwork),
      ])
      if (!fromNet) return error(`Network ${fromNetwork} not found or inactive`, 404)
      if (!toNet) return error(`Network ${toNetwork} not found or inactive`, 404)

      const [fromMapping, toMapping] = await Promise.all([
        prisma.coinNetworkMapping.findUnique({
          where: { coinId_networkId: { coinId: fromCoin.id, networkId: fromNet.id } },
        }),
        prisma.coinNetworkMapping.findUnique({
          where: { coinId_networkId: { coinId: toCoin.id, networkId: toNet.id } },
        }),
      ])
      if (!fromMapping?.isActive) return error(`${from} is not available on ${fromNetwork}`)
      if (!toMapping?.isActive) return error(`${to} is not available on ${toNetwork}`)

      const rate = await getKmsRate(fromCoin.code, toCoin.code)
      const inputAmount = new Prisma.Decimal(amount)

      if (inputAmount.lt(fromCoin.minDepositAmount)) {
        return error(`Amount below minimum of ${fromCoin.minDepositAmount} ${from}`)
      }
      if (fromCoin.maxDepositAmount && inputAmount.gt(fromCoin.maxDepositAmount)) {
        return error(`Amount above maximum of ${fromCoin.maxDepositAmount} ${from}`)
      }

      let feeAmount = inputAmount.mul(fromCoin.floatFeePercent).div(100)
      if (feeAmount.lt(fromCoin.minimumFee)) feeAmount = fromCoin.minimumFee
      const result = inputAmount.minus(feeAmount).mul(rate)

      return json({
        result: {
          result: result.toString(),
          amount: inputAmount.toString(),
          rate: rate.toString(),
          feeAmount: feeAmount.toString(),
          minAmount: fromCoin.minDepositAmount.toString(),
          maxAmount: fromCoin.maxDepositAmount?.toString() ?? null,
        },
        status: 200,
      })
    } catch (e: any) {
      return error(e.message, 500)
    }
  }

  // ─── POST /api/v1/order ───────────────────────────────
  if (method === "POST" && path === "/api/v1/order") {
    let body: any
    try {
      body = await req.json()
    } catch {
      return error("Invalid JSON body")
    }

    const { from, fromNetwork, to, toNetwork, amount, address } = body ?? {}
    if (!from || !fromNetwork || !to || !toNetwork || !amount || !address) {
      return error("Required fields: from, fromNetwork, to, toNetwork, amount, address")
    }

    try {
      const fromUpper = String(from).toUpperCase()
      const toUpper = String(to).toUpperCase()
      const fromNetUpper = String(fromNetwork).toUpperCase()
      const toNetUpper = String(toNetwork).toUpperCase()
      const trimmedAddress = String(address).trim()
      if (!trimmedAddress) return error("Withdraw address is required")

      const [fromCoin, toCoin] = await Promise.all([
        prisma.coin.findFirst({ where: { code: fromUpper, status: "ACTIVE" } }),
        prisma.coin.findFirst({ where: { code: toUpper, status: "ACTIVE" } }),
      ])
      if (!fromCoin) return error(`Coin ${fromUpper} not found or inactive`, 404)
      if (!toCoin) return error(`Coin ${toUpper} not found or inactive`, 404)

      const [fromNet, toNet] = await Promise.all([
        resolveNetwork(prisma, fromNetUpper),
        resolveNetwork(prisma, toNetUpper),
      ])
      if (!fromNet) return error(`Network ${fromNetUpper} not found or inactive`, 404)
      if (!toNet) return error(`Network ${toNetUpper} not found or inactive`, 404)

      const [fromMapping, toMapping] = await Promise.all([
        prisma.coinNetworkMapping.findUnique({
          where: { coinId_networkId: { coinId: fromCoin.id, networkId: fromNet.id } },
        }),
        prisma.coinNetworkMapping.findUnique({
          where: { coinId_networkId: { coinId: toCoin.id, networkId: toNet.id } },
        }),
      ])
      if (!fromMapping?.isActive || !fromMapping.depositEnabled) {
        return error(`Deposits for ${fromUpper} on ${fromNetUpper} are not available`)
      }
      if (!toMapping?.isActive || !toMapping.withdrawEnabled) {
        return error(`Withdrawals for ${toUpper} on ${toNetUpper} are not available`)
      }

      const inputAmount = new Prisma.Decimal(String(amount))
      if (inputAmount.lte(0)) return error("Amount must be positive")
      if (inputAmount.lt(fromCoin.minDepositAmount)) {
        return error(`Amount below minimum of ${fromCoin.minDepositAmount} ${fromUpper}`)
      }
      if (fromCoin.maxDepositAmount && inputAmount.gt(fromCoin.maxDepositAmount)) {
        return error(`Amount above maximum of ${fromCoin.maxDepositAmount} ${fromUpper}`)
      }

      const rate = await getKmsRate(fromCoin.code, toCoin.code)
      let feeAmount = inputAmount.mul(fromCoin.floatFeePercent).div(100)
      if (feeAmount.lt(fromCoin.minimumFee)) feeAmount = fromCoin.minimumFee
      const toAmount = inputAmount.minus(feeAmount).mul(rate)

      const masterWallet = await prisma.masterWallet.findFirst({
        where: { coinId: fromCoin.id, networkId: fromNet.id, status: "ACTIVE" },
      })
      if (!masterWallet) {
        return error(`No active master wallet for ${fromUpper} on ${fromNetUpper}. Contact support.`, 503)
      }

      const exchangeRequest = await prisma.$transaction(
        async (tx) => {
          const updatedWallet = await tx.masterWallet.update({
            where: { xpub: masterWallet.xpub },
            data: { currentIndex: { increment: 1 }, generatedAddresses: { increment: 1 } },
          })

          const derivedAddress = await deriveDepositAddress({
            xpub: masterWallet.xpub,
            index: updatedWallet.currentIndex,
            chain: fromNet.chain,
          })

          const depositAddress = await tx.depositAddress.create({
            data: {
              address: derivedAddress,
              index: updatedWallet.currentIndex,
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
            include: exchangeRequestInclude,
          })
        },
        { timeout: 20_000, maxWait: 5_000 },
      )

      return json({ result: serializeExchangeRequest(exchangeRequest), status: 200 })
    } catch (e: any) {
      return error(e.message, 500)
    }
  }

  // ─── GET /api/v1/order/:id ────────────────────────────
  const orderMatch = path.match(/^\/api\/v1\/order\/([a-zA-Z0-9_-]+)$/)
  if (method === "GET" && orderMatch) {
    const identifier = orderMatch[1]!
    const er = await prisma.exchangeRequest.findFirst({
      where: { OR: [{ orderId: identifier }, { id: identifier }] },
      include: exchangeRequestInclude,
    })
    if (!er) return error("Exchange request not found", 404)
    return json({ result: serializeExchangeRequest(er), status: 200 })
  }

  // ─── GET /api/v1/orders?page=1&pageSize=20&status= ───
  if (method === "GET" && path === "/api/v1/orders") {
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize")) || 20))
    const statusParam = url.searchParams.get("status")?.toUpperCase()
    const where = statusParam ? { status: statusParam as any } : {}
    const skip = (page - 1) * pageSize

    const [items, totalCount] = await Promise.all([
      prisma.exchangeRequest.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: exchangeRequestInclude,
      }),
      prisma.exchangeRequest.count({ where }),
    ])

    const totalPages = Math.ceil(totalCount / pageSize)
    return json({
      result: items.map(serializeExchangeRequest),
      pagination: { currentPage: page, totalPages, totalCount, hasNextPage: page < totalPages },
      status: 200,
    })
  }

  return null // not handled
}
