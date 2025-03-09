// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../contracts/MegaFlashBot.sol";

contract MegaFlashBotTest is Test {
    MegaFlashBot bot;
    address owner = address(this);
    address lendingPool = address(0x123);
    address uniswapRouter = address(0x456);
    address dai = address(0x789);

    function setUp() public {
        bot = new MegaFlashBot(
            lendingPool,
            uniswapRouter,
            dai,
            100,   // profitThreshold
            100    // slippageTolerance
        );
        bot.transferOwnership(owner);
    }

    function testMaxSlippageExceeded() public {
        vm.prank(owner);
        vm.expectRevert("MaxSlippageExceeded");
        bot.executeFlashLoan(
            1000e18,
            dai,
            address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2), // WETH
            address(0), // token2
            MegaFlashBot.ArbitrageType.TWO_TOKEN,
            200 // slippageTolerance > maxSlippage (50)
        );
    }

    function testTriangularArbitrageSlippage() public {
        vm.prank(owner);
        vm.expectRevert("MaxSlippageExceeded");
        bot.executeTriangularArbitrage(
            dai,
            address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2), // WETH
            address(0x6B175474E89094C44Da98b954EedeAC495271d0F), // DAI
            1000e18,
            200 // slippageTolerance > maxSlippage (50)
        );
    }

    function testNoProfit() public {
        vm.prank(owner);
        vm.expectRevert("NoProfit");
        bot.executeFlashLoan(
            1000e18,
            dai,
            address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2), // WETH
            address(0), // token2
            MegaFlashBot.ArbitrageType.TWO_TOKEN,
            50 // valid slippage
        );
    }
}
