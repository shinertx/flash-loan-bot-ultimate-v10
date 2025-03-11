// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../contracts/interfaces/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract HedgingModule is Ownable {
    using SafeERC20 for IERC20;
    address public dai;

    constructor(address _dai) {
        dai = _dai;
    }

    function executeHedge(uint256 hedgeAmount) external onlyOwner returns (uint256) {
        uint256 profit = hedgeAmount / 200; // Dummy 0.5% profit
        IERC20(dai).safeTransfer(owner(), profit);
        return profit;
    }
}
