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
            0x456, // Mock DAI
            0x789, // Mock UniswapRouter
            address(0), // MEV module disabled for test
            address(0), // Bridge module disabled for test
            address(0), // Chainlink disabled
            address(0), // Band disabled
            address(0), // UMA disabled
            5000
        );
        bot.transferOwnership(owner);
    }

    function testCircuitBreaker() public {
        bot.setInitialBalance(1000e18);
        bot.setMaxDailyLoss(50e18);
        vm.prank(owner);
        vm.expectRevert("Circuit breaker triggered");
        bot.executeFlashLoan(1000e18);
    }
}

