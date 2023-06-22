import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, handleOrder } from "../../utils/order";
import { getPositionCount, getAccountPositionCount } from "../../utils/position";
import { expectTokenBalanceIncrease } from "../../utils/token";
import { getEventData, getEventDataArray } from "../../utils/event";
import * as keys from "../../utils/keys";

describe("Exchange.FundingFees", () => {
  const { provider } = ethers;
  let fixture;
  let user0, user1, user2, user3, user4;
  let dataStore, ethUsdMarket, ethUsdSingleTokenMarket, exchangeRouter, wnt, usdc;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user1, user2, user3, user4 } = fixture.accounts);
    ({ dataStore, ethUsdMarket, ethUsdSingleTokenMarket, exchangeRouter, wnt, usdc } = fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10_000, 18),
        shortTokenAmount: expandDecimals(5_000_000, 6),
      },
    });

    await handleDeposit(fixture, {
      create: {
        market: ethUsdSingleTokenMarket,
        longTokenAmount: expandDecimals(5_000_000, 6),
        shortTokenAmount: expandDecimals(5_000_000, 6),
      },
    });
  });

  it("funding fees", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 10));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1));

    expect(await dataStore.getUint(keys.fundingUpdatedAtKey(ethUsdMarket.marketToken))).eq(0);

    // ORDER 1
    // user0 opens a $200k long position, using wnt as collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5050, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // ORDER 2
    // user1 opens a $100k short position, using usdc as collateral
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(10 * 1000, 6),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000),
        acceptablePrice: expandDecimals(4950, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    const block = await provider.getBlock();
    expect(await dataStore.getUint(keys.cumulativeBorrowingFactorUpdatedAtKey(ethUsdMarket.marketToken, true))).closeTo(
      block.timestamp,
      100
    );

    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, true))).eq(
      decimalToFloat(200 * 1000)
    );
    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, true))).eq(0);
    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, false))).eq(0);
    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, false))).eq(
      decimalToFloat(100 * 1000)
    );

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getPositionCount(dataStore)).eq(2);

    await time.increase(14 * 24 * 60 * 60);

    // ORDER 3
    // user0 decreases the long position by $190k, remaining long position size is $10k
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(190 * 1000),
        acceptablePrice: expandDecimals(4950, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: async ({ logs }) => {
          const feeInfo = getEventData(logs, "PositionFeesCollected");
          expect(feeInfo.fundingFeeAmount).eq("1612804000000000"); // 0.001612804 ETH, 8.06402 USD
          expect(feeInfo.collateralToken).eq(wnt.address);
          const claimableFundingData = getEventDataArray(logs, "ClaimableFundingUpdated");
          expect(claimableFundingData.length).eq(0);
        },
      },
    });

    expect(await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdMarket.marketToken, wnt.address, true))).eq(
      "8064019999999995000000000"
    );
    expect(await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdMarket.marketToken, wnt.address, false))).eq(
      "-16128039999999990000000000"
    );
    expect(await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdMarket.marketToken, usdc.address, true))).eq("0");
    expect(await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdMarket.marketToken, usdc.address, false))).eq("0");

    // ORDER 4
    // user1 decreases the short position by $80k, remaining short position size is $20k
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(80 * 1000),
        acceptablePrice: expandDecimals(5050, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: async ({ logs }) => {
          const feeInfo = getEventData(logs, "PositionFeesCollected");
          expect(feeInfo.fundingFeeAmount).closeTo("24", "10");
          expect(feeInfo.collateralToken).eq(usdc.address);
          const claimableFundingData = getEventDataArray(logs, "ClaimableFundingUpdated");
          expect(claimableFundingData.length).eq(1);
          expect(claimableFundingData[0].token).eq(wnt.address);
          expect(claimableFundingData[0].delta).eq("1612803999999999"); // 0.001612803999999999 ETH, ~$8.06402
        },
      },
    });

    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, true))).eq(
      decimalToFloat(10 * 1000)
    );
    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, true))).eq(0);
    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, false))).eq(0);
    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, false))).eq(
      decimalToFloat(20 * 1000)
    );

    // long positions using wnt for collateral should pay a funding fee
    expect(await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdMarket.marketToken, wnt.address, true))).eq(
      "8064019999999995000000000"
    );
    expect(await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdMarket.marketToken, wnt.address, false))).eq(
      "-16128039999999990000000000"
    );
    expect(await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdMarket.marketToken, usdc.address, true))).closeTo(
      "-2400000000000",
      "1000000000000"
    );
    expect(await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdMarket.marketToken, usdc.address, false))).closeTo(
      "240000000000",
      "1000000000000"
    );

    expect(
      await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user1.address))
    ).eq("1612803999999999");

    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user1).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "1612803999999999",
    });

    await time.increase(14 * 24 * 60 * 60);

    // ORDER 5
    // user0 decreases the long position by $10k, remaining long position size is $0
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(10 * 1000),
        acceptablePrice: expandDecimals(4950, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: async ({ logs }) => {
          const feeInfo = getEventData(logs, "PositionFeesCollected");
          expect(feeInfo.fundingFeeAmount).eq("0");
          expect(feeInfo.collateralToken).eq(wnt.address);
          const claimableFundingData = getEventDataArray(logs, "ClaimableFundingUpdated");
          expect(claimableFundingData.length).eq(1);
          expect(claimableFundingData[0].token).eq(usdc.address);
          expect(claimableFundingData[0].delta).closeTo("806434", "10"); // ~$0.806434
        },
      },
    });

    // ORDER 6
    // user1 decreases the short position by $20k, remaining short position size is $0
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(1000, 6),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(20 * 1000),
        acceptablePrice: expandDecimals(5050, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: async ({ logs }) => {
          const feeInfo = getEventData(logs, "PositionFeesCollected");
          expect(feeInfo.fundingFeeAmount).closeTo("806402", "10");
          expect(feeInfo.collateralToken).eq(usdc.address);
          const claimableFundingData = getEventDataArray(logs, "ClaimableFundingUpdated");
          expect(claimableFundingData.length).eq(0);
        },
      },
    });

    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, true))).eq(0);
    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, true))).eq(0);
    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, false))).eq(0);
    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, false))).eq(0);

    expect(await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdMarket.marketToken, wnt.address, true))).eq(
      "8064019999999995000000000"
    ); // 0.000000008064019999 ETH, 0.00004032009 USD
    expect(await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdMarket.marketToken, wnt.address, false))).eq(
      "-16128039999999990000000000"
    ); // -0.000000016128039999 ETH, -0.00008064019 USD
    expect(await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdMarket.marketToken, usdc.address, true))).closeTo(
      "-80642700000000000",
      "1000000000000"
    ); // -0.00008 USD
    expect(await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdMarket.marketToken, usdc.address, false))).closeTo(
      "40320390000000000", // 0.00004 USD
      "100000000000"
    );
  });

  it("funding fees, single token market", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdSingleTokenMarket.marketToken), decimalToFloat(1, 10));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdSingleTokenMarket.marketToken), decimalToFloat(1));

    expect(await dataStore.getUint(keys.fundingUpdatedAtKey(ethUsdSingleTokenMarket.marketToken))).eq(0);

    // ORDER 1
    // user0 opens a $200k long position, using wnt as collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(10_000, 6),
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5050, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // ORDER 2
    // user1 opens a $100k short position, using usdc as collateral
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(10_000, 6),
        sizeDeltaUsd: decimalToFloat(100 * 1000),
        acceptablePrice: expandDecimals(4950, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    await time.increase(14 * 24 * 60 * 60);

    // ORDER 3
    // user0 decreases the long position by $190k, remaining long position size is $10k
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        sizeDeltaUsd: decimalToFloat(190 * 1000),
        acceptablePrice: expandDecimals(4950, 12),
        executionFee: expandDecimals(1, 15),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
      execute: {
        afterExecution: async ({ logs }) => {
          const feeInfo = getEventData(logs, "PositionFeesCollected");
          expect(feeInfo.fundingFeeAmount).eq("8064018"); // 8.064018 USD
          expect(feeInfo.collateralToken).eq(usdc.address);
          const claimableFundingData = getEventDataArray(logs, "ClaimableFundingUpdated");
          expect(claimableFundingData.length).eq(0);
        },
      },
    });

    expect(
      await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdSingleTokenMarket.marketToken, usdc.address, true))
    ).eq("40320090000000000");
    expect(
      await dataStore.getInt(keys.fundingAmountPerSizeKey(ethUsdSingleTokenMarket.marketToken, usdc.address, false))
    ).eq("-40320090000000000");

    // ORDER 4
    // user1 decreases the short position by $80k, remaining short position size is $20k
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        sizeDeltaUsd: decimalToFloat(80 * 1000),
        acceptablePrice: expandDecimals(5050, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
      execute: {
        afterExecution: async ({ logs }) => {
          const feeInfo = getEventData(logs, "PositionFeesCollected");
          expect(feeInfo.fundingFeeAmount).eq(0);
          expect(feeInfo.collateralToken).eq(usdc.address);
          const claimableFundingData = getEventDataArray(logs, "ClaimableFundingUpdated");
          expect(claimableFundingData.length).eq(2);
          expect(claimableFundingData[0].token).eq(usdc.address);
          expect(claimableFundingData[0].delta).eq("4031985"); // 4.031985 USD

          expect(claimableFundingData[1].token).eq(usdc.address);
          expect(claimableFundingData[1].delta).eq("4031985"); // 4.031985 USD
        },
      },
    });

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(ethUsdSingleTokenMarket.marketToken, usdc.address, user0.address)
      )
    ).eq(0);

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(ethUsdSingleTokenMarket.marketToken, usdc.address, user1.address)
      )
    ).eq("8063970"); // 8.06397 USD
  });

  // it("validate state without funding fees", async () => {
  //   // ORDER 1
  //   // user0 opens a $200k long position, using wnt as collateral
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user0,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: expandDecimals(10, 18),
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(200_000),
  //       acceptablePrice: expandDecimals(5050, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 2
  //   // user1 opens a $`00k long position, using wnt as collateral
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user1,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: expandDecimals(10, 18),
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_000),
  //       acceptablePrice: expandDecimals(5050, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 3
  //   // user2 opens a $100k long position, using usdc as collateral
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user2,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: expandDecimals(50_000, 6),
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_000),
  //       acceptablePrice: expandDecimals(5050, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 4
  //   // user3 opens a $100k short position, using wnt as collateral
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user3,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: expandDecimals(5, 18),
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_000),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 5
  //   // user4 opens a $100k short position, using wnt as collateral
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user4,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: expandDecimals(25_000, 6),
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_000),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, true))).eq(
  //     decimalToFloat(300_000)
  //   );
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, true))).eq(
  //     decimalToFloat(100_000)
  //   );
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, false))).eq(
  //     decimalToFloat(100_000)
  //   );
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, false))).eq(
  //     decimalToFloat(100_000)
  //   );
  //
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, wnt.address, true))).eq(
  //     expandDecimals(20, 18)
  //   );
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, usdc.address, true))).eq(
  //     expandDecimals(50_000, 6)
  //   );
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, wnt.address, false))).eq(
  //     expandDecimals(5, 18)
  //   );
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, usdc.address, false))).eq(
  //     expandDecimals(25_000, 6)
  //   );
  //
  //   await time.increase(14 * 24 * 60 * 60);
  //
  //   // ORDER 6
  //   // user0 closes the long position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user0,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(200_000),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 6
  //   // user0 opens a $200k short position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user0,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: expandDecimals(50_000, 6),
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(200_000),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 7
  //   // user1 decreases the long position by $1
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user1,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(1),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 8
  //   // user4 increases the short position by $1
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user4,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(1),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, true))).eq(
  //     decimalToFloat(99_999)
  //   );
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, true))).eq(
  //     decimalToFloat(100_000)
  //   );
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, false))).eq(
  //     decimalToFloat(100_000)
  //   );
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, false))).eq(
  //     decimalToFloat(300_001)
  //   );
  //
  //   await time.increase(28 * 24 * 60 * 60);
  //
  //   // ORDER 9
  //   // user0 closes their position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user0,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(200_000),
  //       acceptablePrice: expandDecimals(5050, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 10
  //   // user1 closes their position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user1,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(99_999),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 11
  //   // user2 closes their position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user2,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_000),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 12
  //   // user3 closes their position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user3,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_000),
  //       acceptablePrice: expandDecimals(5050, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 13
  //   // user4 closes their position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user4,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_001),
  //       acceptablePrice: expandDecimals(5050, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, true))).eq(0);
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, true))).eq(0);
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, false))).eq(0);
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, false))).eq(0);
  //
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, wnt.address, true))).eq(0);
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, usdc.address, true))).eq(0);
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, wnt.address, false))).eq(0);
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, usdc.address, false))).eq(0);
  //
  //   const users = [user0, user1, user2, user3, user4];
  //   for (let i = 0; i < users.length; i++) {
  //     await exchangeRouter
  //       .connect(users[i])
  //       .claimFundingFees(
  //         [ethUsdMarket.marketToken, ethUsdMarket.marketToken],
  //         [wnt.address, usdc.address],
  //         users[i].address
  //       );
  //   }
  //
  //   // total ETH collateral: 10 (user0) + 10 (user1) + 5 (user3) = 25 ETH
  //   // total USDC collateral: 50,000 (user0) + 50,000 (user2) + 25,000 (user4) = 125,000 USDC
  //   expect(
  //     (await wnt.balanceOf(user0.address))
  //       .add(await wnt.balanceOf(user1.address))
  //       .add(await wnt.balanceOf(user2.address))
  //       .add(await wnt.balanceOf(user3.address))
  //       .add(await wnt.balanceOf(user4.address))
  //   ).eq("25000000000000000000"); // 25 ETH
  //
  //   expect(
  //     (await usdc.balanceOf(user0.address))
  //       .add(await usdc.balanceOf(user1.address))
  //       .add(await usdc.balanceOf(user2.address))
  //       .add(await usdc.balanceOf(user3.address))
  //       .add(await usdc.balanceOf(user4.address))
  //   ).eq("125000000000"); // 125,000 USDC
  // });

  // it("funding fees after funding switches sides", async () => {
  //   await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
  //   await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1));
  //
  //   expect(await dataStore.getUint(keys.fundingUpdatedAtKey(ethUsdMarket.marketToken))).eq(0);
  //
  //   // ORDER 1
  //   // user0 opens a $200k long position, using wnt as collateral
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user0,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: expandDecimals(10, 18),
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(200_000),
  //       acceptablePrice: expandDecimals(5050, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 2
  //   // user1 opens a $`00k long position, using wnt as collateral
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user1,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: expandDecimals(10, 18),
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_000),
  //       acceptablePrice: expandDecimals(5050, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 3
  //   // user2 opens a $100k long position, using usdc as collateral
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user2,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: expandDecimals(50_000, 6),
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_000),
  //       acceptablePrice: expandDecimals(5050, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 4
  //   // user3 opens a $100k short position, using wnt as collateral
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user3,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: expandDecimals(5, 18),
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_000),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 5
  //   // user4 opens a $100k short position, using wnt as collateral
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user4,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: expandDecimals(25_000, 6),
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_000),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, true))).eq(
  //     decimalToFloat(300_000)
  //   );
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, true))).eq(
  //     decimalToFloat(100_000)
  //   );
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, false))).eq(
  //     decimalToFloat(100_000)
  //   );
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, false))).eq(
  //     decimalToFloat(100_000)
  //   );
  //
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, wnt.address, true))).eq(
  //     expandDecimals(20, 18)
  //   );
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, usdc.address, true))).eq(
  //     expandDecimals(50_000, 6)
  //   );
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, wnt.address, false))).eq(
  //     expandDecimals(5, 18)
  //   );
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, usdc.address, false))).eq(
  //     expandDecimals(25_000, 6)
  //   );
  //
  //   await time.increase(14 * 24 * 60 * 60);
  //
  //   // ORDER 6
  //   // user0 closes the long position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user0,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(200_000),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 6
  //   // user0 opens a $200k short position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user0,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: expandDecimals(50_000, 6),
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(200_000),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 7
  //   // user1 decreases the long position by $1
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user1,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(1),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //     execute: {
  //       afterExecution: async ({ logs }) => {
  //         const feeInfo = getEventData(logs, "PositionFeesCollected");
  //         expect(feeInfo.fundingFeeAmount).eq("806403800000000000"); // 0.8064038 ETH, 4032.019 USD
  //         expect(feeInfo.collateralToken).eq(wnt.address);
  //         const claimableFundingData = getEventDataArray(logs, "ClaimableFundingUpdated");
  //         expect(claimableFundingData.length).eq(0);
  //       },
  //     },
  //   });
  //
  //   // ORDER 8
  //   // user4 increases the short position by $1
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user4,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(1),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketIncrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //     execute: {
  //       afterExecution: async ({ logs }) => {
  //         const feeInfo = getEventData(logs, "PositionFeesCollected");
  //         expect(feeInfo.fundingFeeAmount).eq(0);
  //         expect(feeInfo.collateralToken).eq(usdc.address);
  //       },
  //     },
  //   });
  //
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, true))).eq(
  //     decimalToFloat(99_999)
  //   );
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, true))).eq(
  //     decimalToFloat(100_000)
  //   );
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, false))).eq(
  //     decimalToFloat(100_000)
  //   );
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, false))).eq(
  //     decimalToFloat(300_001)
  //   );
  //
  //   await time.increase(28 * 24 * 60 * 60);
  //
  //   expect(await wnt.balanceOf(user0.address)).eq("8387186400000000001");
  //   expect(await usdc.balanceOf(user0.address)).eq(0);
  //
  //   expect(await wnt.balanceOf(user1.address)).eq(0);
  //   expect(await usdc.balanceOf(user1.address)).eq(0);
  //
  //   expect(await wnt.balanceOf(user2.address)).eq(0);
  //   expect(await usdc.balanceOf(user2.address)).eq(0);
  //
  //   expect(await wnt.balanceOf(user3.address)).eq(0);
  //   expect(await usdc.balanceOf(user3.address)).eq(0);
  //
  //   expect(await wnt.balanceOf(user4.address)).eq(0);
  //   expect(await usdc.balanceOf(user4.address)).eq(0);
  //
  //   // ORDER 9
  //   // user0 closes their position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user0,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(200_000),
  //       acceptablePrice: expandDecimals(5050, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 10
  //   // user1 closes their position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user1,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(99_999),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 11
  //   // user2 closes their position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user2,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_000),
  //       acceptablePrice: expandDecimals(4950, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: true,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 12
  //   // user3 closes their position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user3,
  //       market: ethUsdMarket,
  //       initialCollateralToken: wnt,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_000),
  //       acceptablePrice: expandDecimals(5050, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   // ORDER 13
  //   // user4 closes their position
  //   await handleOrder(fixture, {
  //     create: {
  //       account: user4,
  //       market: ethUsdMarket,
  //       initialCollateralToken: usdc,
  //       initialCollateralDeltaAmount: 0,
  //       swapPath: [],
  //       sizeDeltaUsd: decimalToFloat(100_001),
  //       acceptablePrice: expandDecimals(5050, 12),
  //       executionFee: expandDecimals(1, 15),
  //       minOutputAmount: 0,
  //       orderType: OrderType.MarketDecrease,
  //       isLong: false,
  //       shouldUnwrapNativeToken: false,
  //     },
  //   });
  //
  //   console.log("check 1");
  //
  //   expect(await wnt.balanceOf(user0.address)).eq("8387186400000000001"); // 8.387186400000000001 ETH
  //   expect(await usdc.balanceOf(user0.address)).eq("33871772054"); // 33,871.772054 USDC
  //
  //   console.log("check 2");
  //
  //   expect(await wnt.balanceOf(user1.address)).eq("9193594200000000000"); // 9.1935962 ETH
  //   expect(await usdc.balanceOf(user1.address)).eq(0);
  //
  //   console.log("check 3");
  //
  //   expect(await wnt.balanceOf(user2.address)).eq(0);
  //   expect(await usdc.balanceOf(user2.address)).eq("50000000000"); // 50,000 USDC
  //
  //   console.log("check 4");
  //
  //   expect(await wnt.balanceOf(user3.address)).eq("4596789122046420643"); // 4.596789122046420643 ETH
  //   expect(await usdc.balanceOf(user3.address)).eq(0);
  //
  //   console.log("check 5");
  //   expect(await wnt.balanceOf(user4.address)).eq(0);
  //   expect(await usdc.balanceOf(user4.address)).eq("16935801303"); // 16,935.801303 USDC
  //
  //   console.log("check 6");
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, true))).eq(0);
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, true))).eq(0);
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, false))).eq(0);
  //   expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, false))).eq(0);
  //
  //   console.log("check 7");
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, wnt.address, true))).eq(0);
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, usdc.address, true))).eq(0);
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, wnt.address, false))).eq(0);
  //   expect(await dataStore.getUint(keys.collateralSumKey(ethUsdMarket.marketToken, usdc.address, false))).eq(0);
  //   console.log("check 8");
  //
  //   const users = [user0, user1, user2, user3, user4];
  //   for (let i = 0; i < users.length; i++) {
  //     await exchangeRouter
  //       .connect(users[i])
  //       .claimFundingFees(
  //         [ethUsdMarket.marketToken, ethUsdMarket.marketToken],
  //         [wnt.address, usdc.address],
  //         users[i].address
  //       );
  //   }
  //
  //   // 41,935.932 + 33,871.772054 = 75,807.704054
  //   // total initial collateral amount: 10 ETH, 50,000 USDC (50,000 + 50,000 = $100,000)
  //   // diff: 75,807.6973862 - 100,000 = -24,192.3026138
  //   expect(await wnt.balanceOf(user0.address)).eq("8387186400000000001"); // 8.387186400000000001 ETH, 41,935.932 USD
  //   expect(await usdc.balanceOf(user0.address)).eq("33871772054"); // 33,871.772054 USDC
  //
  //   // 50,000.0028265 + 8064.157119 = 58,064.1599455
  //   // initial collateral amount: 10 ETH ($50,000), diff: 58,064.1599455 - 50,000 = 8064.1599455
  //   expect(await wnt.balanceOf(user1.address)).eq("10000000565295075039"); // 10.000000565295075039 ETH, 50,000.0028265 USD
  //   expect(await usdc.balanceOf(user1.address)).eq("8064157119"); // 8064.157119 USDC
  //
  //   // 0.05314726351 + 58,064.247762 = 58,064.3009093
  //   // initial collateral amount: 50,000 USDC, diff: 58,064.3009093 - 50,000 = 8064.3009093
  //   expect(await wnt.balanceOf(user2.address)).eq("10629452702721"); // 0.000010629452702721 ETH, 0.05314726351 USD
  //   expect(await usdc.balanceOf(user2.address)).eq("58064247762"); // 58,064.247762 USDC
  //
  //   // 22,983.9596929 USD
  //   // initial collateral amount: 5 ETH ($25,000), diff: 22,983.9596929 - 25,000 = -2016.0403071
  //   expect(await wnt.balanceOf(user3.address)).eq("4596792605252222240"); // 4.59679193858111112 ETH, 22,983.9596929 USD
  //   expect(await usdc.balanceOf(user3.address)).eq(0);
  //
  //   console.log("check user4 balance");
  //   // 6047.99166658 + 18,951.800386 USDC = 24,999.7920526
  //   // initial collateral amount: 25,000, diff: 24,999.7920526 - 25,000 = -0.20794739999
  //   expect(await wnt.balanceOf(user4.address)).eq("1209598333315555526"); // 1.209598333315555526 ETH, 6047.99166658 USD
  //   expect(await usdc.balanceOf(user4.address)).eq("18951800386"); // 18,951.800386 USDC
  //
  //   // total ETH collateral: 10 (user0) + 10 (user1) + 5 (user3) = 25 ETH
  //   // total USDC collateral: 50,000 (user0) + 50,000 (user2) + 25,000 (user4) = 125,000 USDC
  //   expect(
  //     (await wnt.balanceOf(user0.address))
  //       .add(await wnt.balanceOf(user1.address))
  //       .add(await wnt.balanceOf(user2.address))
  //       .add(await wnt.balanceOf(user3.address))
  //       .add(await wnt.balanceOf(user4.address))
  //   ).eq("24193586133315555527"); // 24.193586133315555527 ETH
  //
  //   expect(
  //     (await usdc.balanceOf(user0.address))
  //       .add(await usdc.balanceOf(user1.address))
  //       .add(await usdc.balanceOf(user2.address))
  //       .add(await usdc.balanceOf(user3.address))
  //       .add(await usdc.balanceOf(user4.address))
  //   ).eq("118951953322"); // 118,951.953322 USDC
  // });
});
