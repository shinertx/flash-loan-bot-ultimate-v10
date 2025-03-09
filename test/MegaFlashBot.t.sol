// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../contracts/MegaFlashBot.sol";

contract MegaFlashBotTest is Test {
    MegaFlashBot bot;
    address owner = address(this);

    function setUp() public {
        bot = new MegaFlashBot(
            0x123, // Mock lendingPool
            0x456, // Mock UniswapV2Router02
            0x789, // Mock DAI
            100,   // profitThreshold
            100    // slippageTolerance
        );
        bot.transferOwnership(owner);
    }

    function testCircuitBreaker() public {
        // Assuming setInitialBalance and setMaxDailyLoss were implemented if needed.
        vm.prank(owner);
        vm.expectRevert("Circuit breaker active");
        bot.executeFlashLoan(1000e18, 0x456, 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, address(0), MegaFlashBot.ArbitrageType.TWO_TOKEN, 100);
    }

    function testSetProfitThreshold() public {
        uint256 initialThreshold = bot.profitThreshold();
        uint256 newThreshold = initialThreshold + 1000;
        vm.prank(owner);
        bot.setProfitThreshold(newThreshold);
        assertEq(bot.profitThreshold(), newThreshold);
    }

    function testToggleEmergencyStop() public {
        vm.prank(owner);
        bot.triggerEmergencyStop();
        // Assuming emergency flag is public.
        assertEq(bot.emergency(), true);
        vm.prank(owner);
        bot.resumeOperation();
        assertEq(bot.emergency(), false);
    }

    function testToggleCircuitBreaker() public {
        vm.prank(owner);
        bot.toggleCircuitBreaker();
        assertEq(bot.circuitBreaker(), false);
        vm.prank(owner);
        bot.toggleCircuitBreaker();
        assertEq(bot.circuitBreaker(), true);
    }
}
