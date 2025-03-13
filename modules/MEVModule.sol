// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/IUniswapV2Router02.sol";
import "../interfaces/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MEVModule is Ownable {
    using SafeERC20 for IERC20;

    address public immutable uniswapRouter;
    address public immutable dai;

    struct Opportunity {
        address targetToken;
        uint256 flashLoanAmount;
        uint256 expectedProfit;
        bytes[] bundle;  // Arbitrary encoded calls
    }

    event OpportunityExecuted(address indexed targetToken, uint256 flashLoanAmount, uint256 profit);

    constructor(address _uniswapRouter, address _dai) {
        uniswapRouter = _uniswapRouter;
        dai = _dai;
    }

    function executeMEVOpportunity(Opportunity calldata opp) external onlyOwner {
        if(opp.bundle.length == 0) {
            return;
        }
        uint256 startBal = IERC20(dai).balanceOf(address(this));
        for (uint256 i=0; i<opp.bundle.length; i++){
            (bool success,) = address(this).call(opp.bundle[i]);
            require(success, "MEV Tx failed");
        }
        uint256 endBal = IERC20(dai).balanceOf(address(this));
        uint256 profit = endBal - startBal;

        emit OpportunityExecuted(opp.targetToken, opp.flashLoanAmount, profit);
    }
}
