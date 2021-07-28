import chai, { expect } from 'chai'
import { Contract } from 'ethers'
import { solidity, MockProvider, createFixtureLoader } from 'ethereum-waffle'
import { BigNumber, bigNumberify } from 'ethers/utils'

import { expandTo18Decimals, mineBlock, encodePrice } from './shared/utilities'
import { pairFixture } from './shared/fixtures'
import { AddressZero } from 'ethers/constants'

import * as R from 'ramda'
import BNjs from 'bignumber.js'

BNjs.config({ DECIMAL_PLACES: 50 })

const MINIMUM_LIQUIDITY = bigNumberify(0)

chai.use(solidity)

const overrides = {
  gasLimit: 9999999
}

describe('UniswapV2Pair', () => {
  const provider = new MockProvider({
    hardfork: 'istanbul',
    mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
    gasLimit: 9999999
  })
  const [wallet, other] = provider.getWallets()
  const loadFixture = createFixtureLoader(provider, [wallet])

  let factory: Contract
  let token0: Contract
  let token1: Contract
  let pair: Contract
  beforeEach(async () => {
    const fixture = await loadFixture(pairFixture)
    factory = fixture.factory
    token0 = fixture.token0
    token1 = fixture.token1
    pair = fixture.pair
  })

  it('mint', async () => {
    const token0Amount = expandTo18Decimals(1)
    const token1Amount = expandTo18Decimals(4)
    await token0.transfer(pair.address, token0Amount)
    await token1.transfer(pair.address, token1Amount)

    const expectedLiquidity = expandTo18Decimals(2)
    await expect(pair.mint(wallet.address, overrides))
      .to.emit(pair, 'Transfer')
      .withArgs(AddressZero, AddressZero, MINIMUM_LIQUIDITY)
      .to.emit(pair, 'Transfer')
      .withArgs(AddressZero, wallet.address, expectedLiquidity.sub(MINIMUM_LIQUIDITY))
      .to.emit(pair, 'Sync')
      .withArgs(token0Amount, token1Amount)
      .to.emit(pair, 'Mint')
      .withArgs(wallet.address, token0Amount, token1Amount)

    expect(await pair.totalSupply()).to.eq(expectedLiquidity)
    expect(await pair.balanceOf(wallet.address)).to.eq(expectedLiquidity.sub(MINIMUM_LIQUIDITY))
    expect(await token0.balanceOf(pair.address)).to.eq(token0Amount)
    expect(await token1.balanceOf(pair.address)).to.eq(token1Amount)
    const reserves = await pair.getReserves()
    expect(reserves[0]).to.eq(token0Amount)
    expect(reserves[1]).to.eq(token1Amount)
  })

  async function addLiquidity(token0Amount: BigNumber, token1Amount: BigNumber) {
    await token0.transfer(pair.address, token0Amount)
    await token1.transfer(pair.address, token1Amount)
    await pair.mint(wallet.address, overrides)
  }

  const logAsString = (...agrs: Array<any>) => (x: any) => console.log(...agrs, R.toString(x))

  const logState = async (label: string = ''): Promise<{ reserves: Reserves, totalSupply: BigNumber, ratio: BNjs }> => {
    label = label !== '' ? `${label}: ` : label

    const reserves = R.map(bigNumberify, R.take(2, (await pair.getReserves())))
    const [x, y] = reserves
    logAsString(label + 'x:           ')(reserves[0])
    logAsString(label + 'y:           ')(reserves[1])
    const totalSupply = await pair.totalSupply()
    console.log(label + 'totalSupply: ', totalSupply.toString())
    const ratio = getRatio(reserves)
    console.log(label + 'ratio:       ', ratio.toString())
    return { reserves: { x, y }, totalSupply, ratio }
  }

  const toBNjs = (value: any) => new BNjs(value.toString())

  const BNjstoBigNumber = (rounding: BNjs.RoundingMode = BNjs.ROUND_DOWN) => (x: any) => bigNumberify(x
    .integerValue(rounding)
    .toString()
  )

  function getDY(deltaX: BigNumber | BNjs, {x, y}: Reserves): BNjs {
    const alpha = toBNjs(deltaX).div(toBNjs(x))
    return alpha
      .times(toBNjs(y))
      .div(alpha.plus(1))
  }

  const getRatio = (reserves: Array<BigNumber>) => toBNjs(reserves[0]).div(toBNjs(reserves[1]))

  const addLiquidityX = async (x: BigNumber, { ratio }: { ratio: BNjs }) => {
    const yString = toBNjs(x).div(ratio).integerValue(BNjs.ROUND_DOWN).toString()
    const y = bigNumberify(yString)

    logAsString('addLiquidity')({ x, y })
    await addLiquidity(x, y)

    // Deltas of user balances
    return { dX: x.mul(-1), dY: y.mul(-1) }
  }


  type Reserves = {
    x: BigNumber,
    y: BigNumber
  }

  /**
    This is derived from following 2 equations:
    1. x × y = (x + ∆x) × (y − ∆y)
    2. targetRatio = (x + ∆x) / (y − ∆y)

    which when combined, give:
    x × y × R = (x + ∆x)²

    and finally:

    ∆x = sqrt(x × y × R) - x

    or (due to (x + ∆x)² and the right side above):

    ∆x = -(sqrt(x × y × R) + x)
  **/
  const getDXforTargetRatio = (
    targetRatio: BNjs,
    { reserves }: { reserves: Reserves }
  ) => {
    logAsString('targetRatio:')(targetRatio)
    const { x, y } = reserves
    logAsString('x:')(x)
    logAsString('y:')(y)

    const sqrtXYR = toBNjs(x)
      .times(toBNjs(y))
      .times(targetRatio)
      .sqrt()
    const dX = sqrtXYR.minus(toBNjs(x))
    // logAsString('dX')(dX)

    const isInRange = dX.isLessThanOrEqualTo(toBNjs(x))

    // dX cannot be greater than x since reserves cannot be negative, so
    // if dX is not in range, we choose the 2nd option mentioned in the comment
    // above.
    return isInRange
      ? dX
      : sqrtXYR.plus(toBNjs(x)).times(-1)
  }

  const getDXDYforTargetRatio = (
    targetRatio: BNjs,
    { reserves }: { reserves: Reserves }
  ) => {
    const dX = getDXforTargetRatio(targetRatio, { reserves })
    const dY = getDY(dX, reserves)
    return { dX, dY }
  }

  const swap = async ({ dX, dY }: { dX: BNjs, dY: BNjs }) => {
    const makeTokenData = (token: any, amount: any) => ({
      token,
      amount: amount.abs()
    })
    const x = makeTokenData(token0, dX)
    const y = makeTokenData(token1, dY)

    const withdrawingX = dX.isLessThan(0)

    // console.log('withdrawingX', withdrawingX)

    const [inData, outData] = withdrawingX
      ? [y, x]
      : [x, y]


    // logAsString('inData.amount:')(inData.amount)
    // logAsString('outData.amount:')(outData.amount)

    // TODO: not sure about the rounding modes here
    const inAmount = BNjstoBigNumber(BNjs.ROUND_DOWN)(inData.amount)
    const outAmount = BNjstoBigNumber(BNjs.ROUND_DOWN)(outData.amount)

    // logAsString('inAmount:')(inAmount)
    // logAsString('outAmount:')(outAmount)
    await inData.token.transfer(pair.address, inAmount)

    await expect(pair.swap(
      inData.token === token0 ? 0 : outAmount,
      inData.token === token0 ? outAmount : 0,
      wallet.address,
      '0x',
      overrides
    ))
      .to.emit(outData.token, 'Transfer')
      .withArgs(pair.address, wallet.address, outAmount)

    // Return deltas of user balances
    return R.zipObj(
      withdrawingX
        ? ['dX', 'dY']
        : ['dY', 'dX'],
      [outAmount, inAmount.mul(-1)]
    )
  }

  const burn = async (burnedLiquidity: BigNumber) => {
    console.log('== BURN ==')
    await pair.transfer(pair.address, burnedLiquidity)
    const res = await (await pair.burn(wallet.address, overrides)).wait()

    const dX = res.events[1].args.value
    const dY = res.events[2].args.value
    return { dX, dY }
  }

  const reduceDeltas = R.reduce(
    (acc, { dY, dX }) => ({
      dY: acc.dY.add(dY),
      dX: acc.dX.add(dX),
    }),
    { dY: bigNumberify(0) ,dX: bigNumberify(0) }
  )

  const prepStateForSyncWithBurn = async () => {
    const tokenXAmount = expandTo18Decimals(2)
    const tokenYAmount = expandTo18Decimals(200)

    await addLiquidity(tokenXAmount, tokenYAmount)

    const initialState = await logState('initialState')

    const tokenXAmountExtra = expandTo18Decimals(2)
    await addLiquidityX(tokenXAmountExtra, initialState)

    const stateAfterAdd = await logState('stateAfterAdd')

    const tokenXAmountSwap = expandTo18Decimals(1)
    const swapDeltas = await swap({
      dX: toBNjs(tokenXAmountSwap),
      dY: getDY(tokenXAmountSwap, stateAfterAdd.reserves)
    })

    const stateAfterAddAndSwap = await logState('stateAfterAddAndSwap')

    return { initialState, stateAfterAddAndSwap }
  }

  it.only('sync state with burn and swap', async () => {
    const { initialState, stateAfterAddAndSwap } = await prepStateForSyncWithBurn()

    // burn to reach initial totalSupply of liquidity tokens
    const liquidityToBurn = stateAfterAddAndSwap.totalSupply.sub(initialState.totalSupply)
    logAsString('liquidityToBurn')(liquidityToBurn)
    const burnDeltas = await burn(liquidityToBurn)
    const stateAfterBurn = await logState('stateAfterBurn')

    // swap to reach the initial ratio
    const deltasNeededToSyncRatio = getDXDYforTargetRatio(initialState.ratio, stateAfterBurn)
    logAsString('deltasNeededToSyncRatio')(deltasNeededToSyncRatio)
    const swapDeltas = await swap(deltasNeededToSyncRatio)

    const finalState = await logState('finalSate')

    expect(finalState).deep.equal(initialState)

    expect(reduceDeltas([
      swapDeltas,
      burnDeltas
    ])).deep.equal({
      dX: expandTo18Decimals(3),
      dY: expandTo18Decimals(120)
    })
  })

  // This tests reaches the same state as above but reverting the order
  // burn and swap.
  it.only('sync state with swap and burn', async () => {
    const { initialState, stateAfterAddAndSwap } = await prepStateForSyncWithBurn()

    // swap to reach the initial ratio
    const deltasNeededToSyncRatio = getDXDYforTargetRatio(initialState.ratio, stateAfterAddAndSwap)
    logAsString('deltasNeededToSyncRatio')(deltasNeededToSyncRatio)
    const swapDeltas = await swap(deltasNeededToSyncRatio)
    const stateAfterSwap = await logState('stateAfterSwap')

    // burn to reach initial totalSupply of liquidity tokens
    const liquidityToBurn = stateAfterSwap.totalSupply.sub(initialState.totalSupply)
    logAsString('liquidityToBurn')(liquidityToBurn)
    const burnDeltas = await burn(liquidityToBurn)


    const finalState = await logState('finalSate')

    expect(finalState).deep.equal(initialState)

    expect(reduceDeltas([
      swapDeltas,
      burnDeltas
    ])).deep.equal({
      dX: expandTo18Decimals(3),
      dY: expandTo18Decimals(120)
    })
  })

  const prepStateForSyncWithMint = async () => {
    const tokenXAmount = expandTo18Decimals(4)
    const tokenYAmount = expandTo18Decimals(400)

    await addLiquidity(tokenXAmount, tokenYAmount)

    const initialState = await logState('initialState')

    const burnedLiquidity = expandTo18Decimals(20)
    await burn(burnedLiquidity)

    const stateAfterBurn = await logState('stateAfterBurn')

    const tokenXAmountSwap = expandTo18Decimals(1)
    const swapDeltas = await swap({
      dX: toBNjs(tokenXAmountSwap),
      dY: getDY(tokenXAmountSwap, stateAfterBurn.reserves)
    })

    const stateAfterBurnAndSwap = await logState('stateAfterBurnAndSwap')

    return { initialState, stateAfterBurnAndSwap }
  }

  it.only('sync state with swap and mint', async () => {
    const { initialState, stateAfterBurnAndSwap } = await prepStateForSyncWithMint()

    // swap to reach the initial ratio
    const deltasNeededToSyncRatio = getDXDYforTargetRatio(initialState.ratio, stateAfterBurnAndSwap)
    logAsString('deltasNeededToSyncRatio')(deltasNeededToSyncRatio)
    const swapDeltas = await swap(deltasNeededToSyncRatio)
    const stateAfterSwap = await logState('stateAfterSwap')

    // burn to reach initial totalSupply of liquidity tokens
    const missingTokenXAmount = initialState.reserves.x.sub(stateAfterSwap.reserves.x)
    logAsString('missingTokenXAmount')(missingTokenXAmount)
    const addDeltas = await addLiquidityX(missingTokenXAmount, stateAfterSwap)

    const finalState = await logState('finalSate')

    expect(finalState.reserves.x).deep.equal(initialState.reserves.x)
    // Small rounding errors on following props
    expect(finalState.reserves.y).deep.equal(initialState.reserves.y.sub(200))
    expect(finalState.totalSupply).deep.equal(initialState.totalSupply.sub(20))
    expect(finalState.ratio.decimalPlaces(10)).deep.equal(initialState.ratio.decimalPlaces(10))

    logAsString()(reduceDeltas([
      swapDeltas,
      addDeltas
    ]))
  })

  // NO test for mint and swap since we don't have an equation which calculates
  // amounts of pair tokens which need to be deposited to mint desired amount of
  // liquidity tokens.

  it('sync state', async () => {
    const tokenXAmount = expandTo18Decimals(2)
    const tokenYAmount = expandTo18Decimals(200)

    await addLiquidity(tokenXAmount, tokenYAmount)

    const initialState = await logState('initialState')

    // The target state has more tokens and liquidity the current state.
    // It is a valid state produced by the following swap
    const targetState = {
      "ratio": new BNjs('0.0225'),
      "reserves": {
        "x": bigNumberify('5000000000000000000'),
        "y": bigNumberify('222222222222222222222')
      }
    }

    // Execute a swap to reach target ratio
    const initialSwapDeltas = await swap(getDXDYforTargetRatio(targetState.ratio, initialState))
    logAsString('initialSwapDeltas:')(initialSwapDeltas)

    const stateAfterSwap = await logState('stateAfterSwap')

    const missingTokenXAmount = targetState.reserves.x.sub(stateAfterSwap.reserves.x)
    logAsString('missingTokenXAmount')(missingTokenXAmount)

    // Add liquidity to reach desired amount of tokens.
    // addLiquidityX takes amount of X tokens to be deposited and calculates
    // correct amount ot Y tokens.
    const addLiquidityDeltas = await addLiquidityX(missingTokenXAmount, stateAfterSwap)

    const targetStateReached = await logState('targetStateReached')

    const burnedLiquidity = (targetStateReached).totalSupply.sub(initialState.totalSupply)

    const burnDeltas = await burn(burnedLiquidity)
    logAsString('burnDeltas:')(burnDeltas)

    const stateAfterBurn = await logState('stateAfterBurn')
    const { dX, dY } = getDXDYforTargetRatio(initialState.ratio, stateAfterBurn)

    const finalSwapDeltas = await swap({ dX, dY })
    logAsString('finalSwapDeltas:')(finalSwapDeltas)

    await logState('finalAmmSate')

    logAsString('final users balance deltas:')(
      R.reduce(
        (acc, { dY, dX }) => ({
          dY: acc.dY.add(dY),
          dX: acc.dX.add(dX),
        }),
        { dY: bigNumberify(0) ,dX: bigNumberify(0) },
        [
          initialSwapDeltas,
          addLiquidityDeltas,
          burnDeltas,
          finalSwapDeltas
        ]
      )
    )
  })

  const swapTestCases: BigNumber[][] = [
    [1, 5, 10, '1662497915624478906'],
    [1, 10, 5, '453305446940074565'],

    [2, 5, 10, '2851015155847869602'],
    [2, 10, 5, '831248957812239453'],

    [1, 10, 10, '906610893880149131'],
    [1, 100, 100, '987158034397061298'],
    [1, 1000, 1000, '996006981039903216']
  ].map(a => a.map(n => (typeof n === 'string' ? bigNumberify(n) : expandTo18Decimals(n))))
  swapTestCases.forEach((swapTestCase, i) => {
    it.skip(`getInputPrice:${i}`, async () => {
      const [swapAmount, token0Amount, token1Amount, expectedOutputAmount] = swapTestCase
      await addLiquidity(token0Amount, token1Amount)
      await token0.transfer(pair.address, swapAmount)
      await expect(pair.swap(0, expectedOutputAmount.add(1), wallet.address, '0x', overrides)).to.be.revertedWith(
        'UniswapV2: K'
      )
      await pair.swap(0, expectedOutputAmount, wallet.address, '0x', overrides)
    })
  })

  const optimisticTestCases: BigNumber[][] = [
    ['997000000000000000', 5, 10, 1], // given amountIn, amountOut = floor(amountIn * .997)
    ['997000000000000000', 10, 5, 1],
    ['997000000000000000', 5, 5, 1],
    [1, 5, 5, '1003009027081243732'] // given amountOut, amountIn = ceiling(amountOut / .997)
  ].map(a => a.map(n => (typeof n === 'string' ? bigNumberify(n) : expandTo18Decimals(n))))
  optimisticTestCases.forEach((optimisticTestCase, i) => {
    it.skip(`optimistic:${i}`, async () => {
      const [outputAmount, token0Amount, token1Amount, inputAmount] = optimisticTestCase
      await addLiquidity(token0Amount, token1Amount)
      await token0.transfer(pair.address, inputAmount)
      await expect(pair.swap(outputAmount.add(1), 0, wallet.address, '0x', overrides)).to.be.revertedWith(
        'UniswapV2: K'
      )
      await pair.swap(outputAmount, 0, wallet.address, '0x', overrides)
    })
  })

  it('swap:token0', async () => {
    const token0Amount = expandTo18Decimals(5)
    const token1Amount = expandTo18Decimals(10)
    await addLiquidity(token0Amount, token1Amount)

    const swapAmount = expandTo18Decimals(1)
    const expectedOutputAmount = bigNumberify('1662497915624478906')
    await token0.transfer(pair.address, swapAmount)
    await expect(pair.swap(0, expectedOutputAmount, wallet.address, '0x', overrides))
      .to.emit(token1, 'Transfer')
      .withArgs(pair.address, wallet.address, expectedOutputAmount)
      .to.emit(pair, 'Sync')
      .withArgs(token0Amount.add(swapAmount), token1Amount.sub(expectedOutputAmount))
      .to.emit(pair, 'Swap')
      .withArgs(wallet.address, swapAmount, 0, 0, expectedOutputAmount, wallet.address)

    const reserves = await pair.getReserves()
    expect(reserves[0]).to.eq(token0Amount.add(swapAmount))
    expect(reserves[1]).to.eq(token1Amount.sub(expectedOutputAmount))
    expect(await token0.balanceOf(pair.address)).to.eq(token0Amount.add(swapAmount))
    expect(await token1.balanceOf(pair.address)).to.eq(token1Amount.sub(expectedOutputAmount))
    const totalSupplyToken0 = await token0.totalSupply()
    const totalSupplyToken1 = await token1.totalSupply()
    expect(await token0.balanceOf(wallet.address)).to.eq(totalSupplyToken0.sub(token0Amount).sub(swapAmount))
    expect(await token1.balanceOf(wallet.address)).to.eq(totalSupplyToken1.sub(token1Amount).add(expectedOutputAmount))
  })

  it('swap:token1', async () => {
    const token0Amount = expandTo18Decimals(5)
    const token1Amount = expandTo18Decimals(10)
    await addLiquidity(token0Amount, token1Amount)

    const swapAmount = expandTo18Decimals(1)
    const expectedOutputAmount = bigNumberify('453305446940074565')
    await token1.transfer(pair.address, swapAmount)
    await expect(pair.swap(expectedOutputAmount, 0, wallet.address, '0x', overrides))
      .to.emit(token0, 'Transfer')
      .withArgs(pair.address, wallet.address, expectedOutputAmount)
      .to.emit(pair, 'Sync')
      .withArgs(token0Amount.sub(expectedOutputAmount), token1Amount.add(swapAmount))
      .to.emit(pair, 'Swap')
      .withArgs(wallet.address, 0, swapAmount, expectedOutputAmount, 0, wallet.address)

    const reserves = await pair.getReserves()
    expect(reserves[0]).to.eq(token0Amount.sub(expectedOutputAmount))
    expect(reserves[1]).to.eq(token1Amount.add(swapAmount))
    expect(await token0.balanceOf(pair.address)).to.eq(token0Amount.sub(expectedOutputAmount))
    expect(await token1.balanceOf(pair.address)).to.eq(token1Amount.add(swapAmount))
    const totalSupplyToken0 = await token0.totalSupply()
    const totalSupplyToken1 = await token1.totalSupply()
    expect(await token0.balanceOf(wallet.address)).to.eq(totalSupplyToken0.sub(token0Amount).add(expectedOutputAmount))
    expect(await token1.balanceOf(wallet.address)).to.eq(totalSupplyToken1.sub(token1Amount).sub(swapAmount))
  })

  it.skip('swap:gas', async () => {
    const token0Amount = expandTo18Decimals(5)
    const token1Amount = expandTo18Decimals(10)
    await addLiquidity(token0Amount, token1Amount)

    // ensure that setting price{0,1}CumulativeLast for the first time doesn't affect our gas math
    await mineBlock(provider, (await provider.getBlock('latest')).timestamp + 1)
    await pair.sync(overrides)

    const swapAmount = expandTo18Decimals(1)
    const expectedOutputAmount = bigNumberify('453305446940074565')
    await token1.transfer(pair.address, swapAmount)
    await mineBlock(provider, (await provider.getBlock('latest')).timestamp + 1)
    const tx = await pair.swap(expectedOutputAmount, 0, wallet.address, '0x', overrides)
    const receipt = await tx.wait()
    expect(receipt.gasUsed).to.eq(73462)
  })

  it('burn', async () => {
    const token0Amount = expandTo18Decimals(3)
    const token1Amount = expandTo18Decimals(3)
    await addLiquidity(token0Amount, token1Amount)

    const expectedLiquidity = expandTo18Decimals(3)
    await pair.transfer(pair.address, expectedLiquidity)

    await expect(pair.burn(wallet.address, overrides))
      .to.emit(pair, 'Transfer')
      .withArgs(pair.address, AddressZero, expectedLiquidity)
      .to.emit(token0, 'Transfer')
      .withArgs(pair.address, wallet.address, token0Amount)
      .to.emit(token1, 'Transfer')
      .withArgs(pair.address, wallet.address, token1Amount)
      .to.emit(pair, 'Sync')
      .withArgs(0, 0)
      .to.emit(pair, 'Burn')
      .withArgs(wallet.address, token0Amount, token1Amount, wallet.address)

    expect(await pair.balanceOf(wallet.address)).to.eq(0)
    expect(await pair.totalSupply()).to.eq(MINIMUM_LIQUIDITY)
    expect(await token0.balanceOf(pair.address)).to.eq(0)
    expect(await token1.balanceOf(pair.address)).to.eq(0)
    const totalSupplyToken0 = await token0.totalSupply()
    const totalSupplyToken1 = await token1.totalSupply()
    expect(await token0.balanceOf(wallet.address)).to.eq(totalSupplyToken0)
    expect(await token1.balanceOf(wallet.address)).to.eq(totalSupplyToken1)
  })

  it('price{0,1}CumulativeLast', async () => {
    const token0Amount = expandTo18Decimals(3)
    const token1Amount = expandTo18Decimals(3)
    await addLiquidity(token0Amount, token1Amount)

    const blockTimestamp = (await pair.getReserves())[2]
    await mineBlock(provider, blockTimestamp + 1)
    await pair.sync(overrides)

    const initialPrice = encodePrice(token0Amount, token1Amount)
    expect(await pair.price0CumulativeLast()).to.eq(initialPrice[0])
    expect(await pair.price1CumulativeLast()).to.eq(initialPrice[1])
    expect((await pair.getReserves())[2]).to.eq(blockTimestamp + 1)

    const swapAmount = expandTo18Decimals(3)
    await token0.transfer(pair.address, swapAmount)
    await mineBlock(provider, blockTimestamp + 10)
    // swap to a new price eagerly instead of syncing
    await pair.swap(0, expandTo18Decimals(1), wallet.address, '0x', overrides) // make the price nice

    expect(await pair.price0CumulativeLast()).to.eq(initialPrice[0].mul(10))
    expect(await pair.price1CumulativeLast()).to.eq(initialPrice[1].mul(10))
    expect((await pair.getReserves())[2]).to.eq(blockTimestamp + 10)

    await mineBlock(provider, blockTimestamp + 20)
    await pair.sync(overrides)

    const newPrice = encodePrice(expandTo18Decimals(6), expandTo18Decimals(2))
    expect(await pair.price0CumulativeLast()).to.eq(initialPrice[0].mul(10).add(newPrice[0].mul(10)))
    expect(await pair.price1CumulativeLast()).to.eq(initialPrice[1].mul(10).add(newPrice[1].mul(10)))
    expect((await pair.getReserves())[2]).to.eq(blockTimestamp + 20)
  })

  it('feeTo:off', async () => {
    const token0Amount = expandTo18Decimals(1000)
    const token1Amount = expandTo18Decimals(1000)
    await addLiquidity(token0Amount, token1Amount)

    const swapAmount = expandTo18Decimals(1)
    const expectedOutputAmount = bigNumberify('996006981039903216')
    await token1.transfer(pair.address, swapAmount)
    await pair.swap(expectedOutputAmount, 0, wallet.address, '0x', overrides)

    const expectedLiquidity = expandTo18Decimals(1000)
    await pair.transfer(pair.address, expectedLiquidity.sub(MINIMUM_LIQUIDITY))
    await pair.burn(wallet.address, overrides)
    expect(await pair.totalSupply()).to.eq(MINIMUM_LIQUIDITY)
  })

  it.skip('feeTo:on', async () => {
    await factory.setFeeTo(other.address)

    const token0Amount = expandTo18Decimals(1000)
    const token1Amount = expandTo18Decimals(1000)
    await addLiquidity(token0Amount, token1Amount)

    const swapAmount = expandTo18Decimals(1)
    const expectedOutputAmount = bigNumberify('996006981039903216')
    await token1.transfer(pair.address, swapAmount)
    await pair.swap(expectedOutputAmount, 0, wallet.address, '0x', overrides)

    const expectedLiquidity = expandTo18Decimals(1000)
    await pair.transfer(pair.address, expectedLiquidity.sub(MINIMUM_LIQUIDITY))
    await pair.burn(wallet.address, overrides)
    expect(await pair.totalSupply()).to.eq(MINIMUM_LIQUIDITY.add('249750499251388'))
    expect(await pair.balanceOf(other.address)).to.eq('249750499251388')

    // using 1000 here instead of the symbolic MINIMUM_LIQUIDITY because the amounts only happen to be equal...
    // ...because the initial liquidity amounts were equal
    expect(await token0.balanceOf(pair.address)).to.eq(bigNumberify(1000).add('249501683697445'))
    expect(await token1.balanceOf(pair.address)).to.eq(bigNumberify(1000).add('250000187312969'))
  })
})
