// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../contracts/MegaFlashBot.sol";
import "../contracts/interfaces/IUniswapV2Router02.sol";
import "../contracts/interfaces/IERC20.sol";

contract MockAavePool {
    function flashLoanSimple(address receiver, address asset, uint25
