// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../../contracts/interfaces/IERC20.sol";
import "../../contracts/interfaces/IUniswapV2Router02.sol"; //  For swaps
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract HedgingModule is Ownable {
    using SafeERC20 for IERC20;

    address public immutable dai;
    address public immutable weth; // Example correlated asset
    address public immutable uniswapRouter;

    event HedgeExecuted(address indexed tokenSold, address indexed tokenBought, uint256 amountSold, uint256 amountBought);

    constructor(address _dai, address _weth, address _uniswapRouter) {
        dai = _dai;
        weth = _weth;
        uniswapRouter = _uniswapRouter;
    }

    //  Basic hedging function: Swaps a percentage of DAI profits into WETH.
    //  This is a *very* simplified example.  A real hedging strategy would be
    //  far more complex.
    function executeHedge(uint256 daiAmount, uint256 hedgePercentage) external onlyOwner {
        require(hedgePercentage <= 100, "Hedge percentage cannot exceed 100");

        uint256 amountToHedge = (daiAmount * hedgePercentage) / 100;

        // Approve Uniswap to spend DAI
        IERC20(dai).safeApprove(uniswapRouter, 0);
        IERC20(dai).safeApprove(uniswapRouter, amountToHedge);


        address[] memory path = new address[](2);
        path[0] = dai;
        path[1] = weth;

        // Get expected WETH amount (add slippage handling!)
        uint256[] memory amountsOut = IUniswapV2Router02(uniswapRouter).getAmountsOut(amountToHedge, path);
        uint256 amountWETHOutMin = amountsOut[1] * 99 / 100; // 1% slippage tolerance

        // Perform the swap
        uint[] memory amounts = IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
            amountToHedge,
            amountWETHOutMin,
            path,
            address(this), // Send WETH to this module
            block.timestamp
        );

        emit HedgeExecuted(dai, weth, amountToHedge, amounts[1]);
    }

     // Allows to withdraw any tokens (including WETH from hedging)
    function withdraw(address _token, address _recipient, uint256 _amount) external onlyOwner {
        IERC20(_token).safeTransfer(_recipient, _amount);
    }

    // Allows to withdraw all of a given token
    function withdrawAll(address _token, address _recipient) external onlyOwner {
        uint256 balance = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(_recipient, balance);
    }

    // emergency drain
    function emergencyDrain(address _token, address _recipient) external onlyOwner {
        IERC20(_token).safeTransfer(_recipient, IERC20(_token).balanceOf(address(this)));
    }
}
