// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../../interfaces/IUniswapV2Router02.sol";
import "../../interfaces/IERC20.sol";
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
        bytes[] bundle;  // Store encoded transactions
    }

    event OpportunityExecuted(address indexed targetToken, uint256 flashLoanAmount, uint256 profit);
    event SandwichAttackExecuted(address indexed pair, uint256 frontRunAmount, uint256 backRunAmount, uint256 profit);


    constructor(address _uniswapRouter, address _dai) {
        uniswapRouter = _uniswapRouter;
        dai = _dai;
    }

    //  This function is called by MegaFlashBot *within* the flash loan callback.
    function executeMEVOpportunity(Opportunity calldata opp) external onlyOwner {
        if (opp.bundle.length == 0) {
            return; // No bundle to execute
        }
        // Execute the bundle transactions.
        uint256 startBalance = IERC20(dai).balanceOf(address(this));

        for (uint256 i = 0; i < opp.bundle.length; i++) {
            (bool success, ) = address(this).call(opp.bundle[i]);
            require(success, "MEV: Transaction failed");
        }

        uint256 endBalance = IERC20(dai).balanceOf(address(this));
        uint256 profit = endBalance - startBalance;

        emit OpportunityExecuted(opp.targetToken, opp.flashLoanAmount, profit);
    }


    //  Allows off-chain logic to prepare a sandwich attack,
    //  which will be executed *within* the flash loan callback.
    function prepareSandwichAttack(
        address pair,
        uint256 frontRunAmount,
        uint256 backRunAmount,
        bytes calldata frontRunData,
        bytes calldata victimTransaction,
        bytes calldata backRunData
    ) external onlyOwner returns (bytes[] memory) {

        //Approve the router to spend DAI
        IERC20(dai).safeApprove(uniswapRouter, 0);
        IERC20(dai).safeApprove(uniswapRouter, frontRunAmount + backRunAmount);

        bytes[] memory bundle = new bytes[](3);
        bundle[0] = frontRunData;          // Front-run
        bundle[1] = victimTransaction;     // Victim's transaction
        bundle[2] = backRunData;           // Back-run

        emit SandwichAttackExecuted(pair, frontRunAmount, backRunAmount, 0); //Profit calculated in executeMEV

        return bundle;
    }


     // Helper function to create the calldata for a Uniswap V2 swap.
    function encodeUniswapV2Swap(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external pure returns (bytes memory) {
        return abi.encodeWithSelector(
            IUniswapV2Router02.swapExactTokensForTokens.selector,
            amountIn,
            amountOutMin,
            path,
            to,
            deadline
        );
    }
}
